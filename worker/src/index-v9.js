import { buildPushPayload } from "@block65/webcrypto-web-push";
import baseHandler from "./index-v8.js";

const APIFY_ACTOR_ENDPOINT = "https://api.apify.com/v2/acts/xtracto~shopee-scraper/run-sync-get-dataset-items";
const RETENTION_MS = 2 * 24 * 60 * 60 * 1000;
const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8" };

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/api/config" && request.method === "GET") {
      const base = await baseHandler.fetch(request, env, ctx);
      const vapid = await getVapidKeys(env);
      return jsonFrom(base, { vapidPublicKey: vapid.publicKey });
    }

    if (url.pathname === "/api/health" && request.method === "GET") {
      const base = await baseHandler.fetch(request, env, ctx);
      if (!base.ok) return base;
      const data = await base.json().catch(() => ({}));
      const vapid = await getVapidKeys(env);
      return jsonFrom(base, {
        ...data,
        vapidManaged: "d1",
        vapidReady: Boolean(vapid.publicKey && vapid.privateKey),
        productMetadataLocked: true,
        exactProductCheck: true
      });
    }

    if (url.pathname === "/api/products" && request.method === "GET") {
      const auth = await authorizeThroughBase(request, env, ctx);
      if (!auth.ok) return auth;
      return listProductsSafe(env, auth);
    }

    if (url.pathname === "/api/test-notification" && request.method === "POST") {
      const auth = await authorizeThroughBase(request, env, ctx);
      if (!auth.ok) return auth;

      const payload = {
        title: "S. — Thông báo hoạt động",
        body: "Web Push đã kết nối thành công.",
        url: env.ALLOWED_ORIGIN || "/",
        tag: `test-${Date.now()}`
      };

      const sent = await sendPushToAll(env, payload, "test_push_exception");
      return jsonFrom(auth, { ok: true, historySaved: false, sent });
    }

    const checkMatch = url.pathname.match(/^\/api\/products\/([^/]+)\/check$/);
    if (checkMatch && request.method === "POST") {
      const auth = await authorizeThroughBase(request, env, ctx);
      if (!auth.ok) return auth;
      return checkProductSafe(env, decodeURIComponent(checkMatch[1]), ctx, auth);
    }

    return baseHandler.fetch(request, env, ctx);
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil((async () => {
      await cleanupNotifications(env);
      await checkAllProductsSafe(env, controller.scheduledTime);
    })());
  }
};

async function authorizeThroughBase(request, env, ctx) {
  const probe = new Request(new URL("/api/health", request.url), {
    method: "GET",
    headers: { Authorization: request.headers.get("Authorization") || "" }
  });
  return baseHandler.fetch(probe, env, ctx);
}

async function listProductsSafe(env, authResponse) {
  const result = await env.DB.prepare(
    `SELECT id, url, canonical_url, shop_id, item_id, name, image_url,
            baseline_price, current_price, lowest_price, last_notified_price,
            active, created_at, checked_at, check_error
       FROM products
      WHERE active = 1
      ORDER BY created_at DESC`
  ).all();

  const rows = result.results || [];
  const repaired = [];
  for (const row of rows) {
    repaired.push(await repairCorruptMetadata(env, row));
  }
  return jsonFrom(authResponse, { products: repaired });
}

async function repairCorruptMetadata(env, row) {
  const stableName = titleFromListingUrl(row.url);
  if (!stableName || !metadataLooksWrong(row.name, stableName)) {
    return row;
  }

  const now = new Date().toISOString();
  const ids = { shopId: String(row.shop_id), itemId: String(row.item_id) };
  let fresh = null;

  try {
    fresh = await fetchProductPriceSafe(env, ids, stableName);
  } catch (error) {
    console.warn(JSON.stringify({
      event: "metadata_repair_price_failed",
      productId: row.id,
      error: readableError(error)
    }));
  }

  const nextPrice = fresh?.price || Number(row.current_price);
  const oldLowest = validPrice(row.lowest_price);
  const nextLowest = fresh?.price
    ? (oldLowest ? Math.min(oldLowest, fresh.price) : fresh.price)
    : Number(row.lowest_price);
  const nextImage = fresh?.imageUrl || row.image_url || null;

  await env.DB.prepare(
    `UPDATE products
        SET name = ?, image_url = ?, current_price = ?, lowest_price = ?,
            checked_at = ?, check_error = NULL
      WHERE id = ?`
  ).bind(
    stableName,
    nextImage,
    nextPrice,
    nextLowest,
    fresh ? now : row.checked_at,
    row.id
  ).run();

  if (fresh?.price) {
    await insertHistory(env, row.id, fresh.price, now);
  }

  return {
    ...row,
    name: stableName,
    image_url: nextImage,
    current_price: nextPrice,
    lowest_price: nextLowest,
    checked_at: fresh ? now : row.checked_at,
    check_error: null
  };
}

async function checkProductSafe(env, id, ctx, authResponse) {
  const row = await env.DB.prepare("SELECT * FROM products WHERE id = ? AND active = 1")
    .bind(id)
    .first();

  if (!row) {
    return jsonFrom(authResponse, { error: "Không tìm thấy sản phẩm." }, 404);
  }

  try {
    const checked = await refreshTrackedProductSafe(env, row);
    if (checked.shouldNotify) {
      ctx.waitUntil(notifyPriceDrop(env, checked.product));
    }
    return jsonFrom(authResponse, {
      ok: true,
      product: checked.product,
      notified: checked.shouldNotify,
      source: "apify-exact"
    });
  } catch (error) {
    const message = readableError(error);
    await env.DB.prepare(
      "UPDATE products SET checked_at = ?, check_error = ? WHERE id = ?"
    ).bind(new Date().toISOString(), message.slice(0, 500), id).run();

    return jsonFrom(authResponse, {
      error: `Không cập nhật được giá. ${message}`,
      code: "EXACT_PRICE_CHECK_FAILED"
    }, 502);
  }
}

async function checkAllProductsSafe(env, scheduledTime) {
  const startedAt = new Date(scheduledTime || Date.now()).toISOString();
  const result = await env.DB.prepare(
    "SELECT * FROM products WHERE active = 1 ORDER BY created_at ASC"
  ).all();
  const products = result.results || [];

  console.log(JSON.stringify({
    event: "daily_exact_start",
    startedAt,
    products: products.length
  }));

  for (const row of products) {
    try {
      const checked = await refreshTrackedProductSafe(env, row);
      if (checked.shouldNotify) {
        await notifyPriceDrop(env, checked.product);
      }
    } catch (error) {
      const message = readableError(error).slice(0, 500);
      await env.DB.prepare(
        "UPDATE products SET checked_at = ?, check_error = ? WHERE id = ?"
      ).bind(new Date().toISOString(), message, row.id).run();
      console.error(JSON.stringify({
        event: "daily_exact_failed",
        productId: row.id,
        error: message
      }));
    }
  }
}

async function refreshTrackedProductSafe(env, row) {
  const ids = { shopId: String(row.shop_id), itemId: String(row.item_id) };
  const stableName = titleFromListingUrl(row.url) || row.name || `Shopee ${row.id}`;
  const fresh = await fetchProductPriceSafe(env, ids, stableName);
  const now = new Date().toISOString();

  const previousLowest = validPrice(row.lowest_price);
  const lowest = previousLowest ? Math.min(previousLowest, fresh.price) : fresh.price;
  const shouldNotify = fresh.price < Number(row.baseline_price) &&
    (row.last_notified_price === null || fresh.price < Number(row.last_notified_price));

  await env.DB.prepare(
    `UPDATE products
        SET name = ?, current_price = ?, lowest_price = ?,
            checked_at = ?, check_error = NULL
      WHERE id = ?`
  ).bind(
    stableName,
    fresh.price,
    lowest,
    now,
    row.id
  ).run();

  await insertHistory(env, row.id, fresh.price, now);

  return {
    shouldNotify,
    product: {
      ...row,
      name: stableName,
      current_price: fresh.price,
      lowest_price: lowest,
      checked_at: now,
      check_error: null
    }
  };
}

async function fetchProductPriceSafe(env, ids, keywordHint = "") {
  const token = String(env.APIFY_TOKEN || "").trim();
  if (!token) throw new Error("Chưa cấu hình APIFY_TOKEN.");

  const keyword = cleanText(keywordHint).slice(0, 180);
  if (keyword.length >= 2) {
    const rows = await runApify(env, {
      country: "vn",
      mode: "keyword",
      keyword,
      sort: "relevancy",
      maxProducts: 12,
      fetchDetail: false,
      delay: 0.2
    });

    const exact = findByIds(rows, ids);
    if (exact) {
      const parsed = mapApifyProduct(exact, ids);
      if (parsed?.price) return parsed;
    }
  }

  const detailRows = await runApify(env, {
    country: "vn",
    mode: "detail",
    shopId: String(ids.shopId),
    itemId: String(ids.itemId),
    maxProducts: 1,
    delay: 0.2
  });

  const exactDetail = findByIds(detailRows, ids);
  const idlessDetail = detailRows.length === 1 && !extractIds(detailRows[0])
    ? detailRows[0]
    : null;
  const detail = exactDetail || idlessDetail;

  if (!detail) {
    const returned = detailRows[0] ? extractIds(detailRows[0]) : null;
    if (returned) {
      throw new Error(
        `Apify trả nhầm sản phẩm ${returned.shopId}:${returned.itemId}; cần ${ids.shopId}:${ids.itemId}.`
      );
    }
    throw new Error("Apify không trả đúng sản phẩm đang theo dõi.");
  }

  const parsed = mapApifyProduct(detail, ids);
  if (parsed?.price) return parsed;
  throw new Error("Không tìm thấy giá hợp lệ của đúng sản phẩm.");
}

async function runApify(env, input) {
  const endpoint = new URL(APIFY_ACTOR_ENDPOINT);
  endpoint.searchParams.set("token", String(env.APIFY_TOKEN || "").trim());
  endpoint.searchParams.set("timeout", "90");

  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(input)
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Apify HTTP ${response.status}${text ? `: ${truncate(text, 180)}` : ""}`);
  }

  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error("Apify không trả JSON hợp lệ.");
  }

  return Array.isArray(payload)
    ? payload
    : (Array.isArray(payload?.items) ? payload.items : []);
}

function findByIds(rows, ids) {
  return (rows || []).find((row) => {
    const found = extractIds(row);
    return found &&
      found.shopId === String(ids.shopId) &&
      found.itemId === String(ids.itemId);
  }) || null;
}

function extractIds(row) {
  if (!row || typeof row !== "object") return null;
  const shopId = row.shop_id ?? row.shopId ?? row.shopid;
  const itemId = row.item_id ?? row.itemId ?? row.itemid;
  if (shopId !== undefined && itemId !== undefined && shopId !== null && itemId !== null) {
    return { shopId: String(shopId), itemId: String(itemId) };
  }

  const urlValue = row.url || row.product_url || row.productUrl;
  if (urlValue) {
    try {
      const path = decodeURIComponent(new URL(String(urlValue)).pathname || "");
      const named = path.match(/i\.(\d+)\.(\d+)/i);
      if (named) return { shopId: named[1], itemId: named[2] };
      const product = path.match(/\/product\/(\d+)\/(\d+)/i);
      if (product) return { shopId: product[1], itemId: product[2] };
    } catch {}
  }
  return null;
}

function mapApifyProduct(row, ids) {
  if (!row || typeof row !== "object") return null;
  const price = firstValidPrice(
    row.price,
    row.price_min,
    row.priceMin,
    row.price_max,
    row.priceMax,
    row.sale_price,
    row.salePrice
  );
  if (!price) return null;

  return {
    shopId: String(ids.shopId),
    itemId: String(ids.itemId),
    canonicalUrl: `https://shopee.vn/product/${ids.shopId}/${ids.itemId}`,
    name: cleanText(row.name || row.title) || null,
    imageUrl: firstImage(row.image_url, row.imageUrl, row.images?.[0]),
    price
  };
}

async function insertHistory(env, productId, price, checkedAt) {
  await env.DB.prepare(
    "INSERT INTO price_history (product_id, price, checked_at) VALUES (?, ?, ?)"
  ).bind(productId, price, checkedAt).run();
}

async function notifyPriceDrop(env, product) {
  const drop = Number(product.baseline_price) - Number(product.current_price);
  const percent = Math.max(
    1,
    Math.round((drop / Number(product.baseline_price)) * 100)
  );

  const payload = {
    title: `S. — Giá giảm ${percent}%`,
    body: `${product.name}: ${formatVnd(product.current_price)} (ban đầu ${formatVnd(product.baseline_price)})`,
    url: product.canonical_url || product.url || env.ALLOWED_ORIGIN || "/",
    tag: `price-${product.id}-${product.current_price}`
  };

  await env.DB.prepare(
    `INSERT INTO notifications (type, product_id, title, body, url, created_at, read_at)
     VALUES ('price_drop', ?, ?, ?, ?, ?, NULL)`
  ).bind(
    product.id,
    payload.title,
    payload.body,
    payload.url || null,
    new Date().toISOString()
  ).run();

  await env.DB.prepare(
    "UPDATE products SET last_notified_price = ? WHERE id = ?"
  ).bind(product.current_price, product.id).run();

  await sendPushToAll(env, payload, "price_push_exception");
}

async function sendPushToAll(env, payload, eventName = "push_exception") {
  const vapid = await getVapidKeys(env);
  const result = await env.DB.prepare(
    "SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE revoked_at IS NULL"
  ).all();

  let sent = 0;
  for (const sub of result.results || []) {
    try {
      const init = await buildPushPayload(
        { data: JSON.stringify(payload), options: { ttl: 300 } },
        {
          endpoint: sub.endpoint,
          expirationTime: null,
          keys: { p256dh: sub.p256dh, auth: sub.auth }
        },
        vapid
      );

      const response = await fetch(sub.endpoint, init);
      if (response.ok) {
        sent += 1;
      } else if ([401, 403, 404, 410].includes(response.status)) {
        await env.DB.prepare(
          "UPDATE push_subscriptions SET revoked_at = ? WHERE endpoint = ?"
        ).bind(new Date().toISOString(), sub.endpoint).run();
      } else {
        console.warn(JSON.stringify({
          event: "push_failed",
          status: response.status
        }));
      }
    } catch (error) {
      console.error(JSON.stringify({
        event: eventName,
        error: readableError(error)
      }));
    }
  }
  return sent;
}

async function getVapidKeys(env) {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS runtime_config (
       key TEXT PRIMARY KEY,
       value TEXT NOT NULL,
       updated_at TEXT NOT NULL
     )`
  ).run();

  const stored = await env.DB.prepare(
    "SELECT value FROM runtime_config WHERE key = 'vapid_keys'"
  ).first();

  const parsed = parseStoredVapid(stored?.value);
  if (parsed) return parsed;

  let keys = null;
  const envPublic = String(env.VAPID_PUBLIC_KEY || "").trim();
  const envPrivate = String(env.VAPID_PRIVATE_KEY || "").trim();
  const envSubject = String(env.VAPID_SUBJECT || env.ALLOWED_ORIGIN || "").trim();

  if (envPublic && envPrivate) {
    keys = {
      publicKey: envPublic,
      privateKey: envPrivate,
      subject: envSubject || "https://shopee-theta-amber.vercel.app"
    };
  } else {
    keys = await generateVapidKeys(
      envSubject || "https://shopee-theta-amber.vercel.app"
    );
  }

  await env.DB.prepare(
    `INSERT OR IGNORE INTO runtime_config (key, value, updated_at)
     VALUES ('vapid_keys', ?, ?)`
  ).bind(JSON.stringify(keys), new Date().toISOString()).run();

  const winner = await env.DB.prepare(
    "SELECT value FROM runtime_config WHERE key = 'vapid_keys'"
  ).first();
  return parseStoredVapid(winner?.value) || keys;
}

function parseStoredVapid(value) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(String(value));
    if (parsed?.publicKey && parsed?.privateKey && parsed?.subject) {
      return {
        publicKey: String(parsed.publicKey),
        privateKey: String(parsed.privateKey),
        subject: String(parsed.subject)
      };
    }
  } catch {}
  return null;
}

async function generateVapidKeys(subject) {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"]
  );
  const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const privateJwk = await crypto.subtle.exportKey("jwk", pair.privateKey);

  const x = base64UrlToBytes(publicJwk.x);
  const y = base64UrlToBytes(publicJwk.y);
  if (x.length !== 32 || y.length !== 32 || !privateJwk.d) {
    throw new Error("Không tạo được VAPID key hợp lệ.");
  }

  const rawPublic = new Uint8Array(65);
  rawPublic[0] = 4;
  rawPublic.set(x, 1);
  rawPublic.set(y, 33);

  return {
    subject,
    publicKey: bytesToBase64Url(rawPublic),
    privateKey: String(privateJwk.d)
  };
}

function base64UrlToBytes(value) {
  const normalized = String(value || "").replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function bytesToBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function cleanupNotifications(env) {
  const cutoff = new Date(Date.now() - RETENTION_MS).toISOString();
  await env.DB.prepare(
    "DELETE FROM notifications WHERE type = 'test' OR created_at < ?"
  ).bind(cutoff).run();
}

function titleFromListingUrl(value) {
  try {
    const url = new URL(String(value || ""));
    const path = decodeURIComponent(url.pathname || "").replace(/^\/+/, "");
    const match = path.match(/^(.*)-i\.\d+\.\d+(?:\/)?$/i);
    if (!match?.[1]) return "";
    return cleanText(match[1].replace(/-/g, " "));
  } catch {
    return "";
  }
}

function metadataLooksWrong(currentName, stableName) {
  const a = significantTokens(currentName);
  const b = significantTokens(stableName);
  if (!a.size || !b.size) return false;

  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection += 1;
  const denominator = Math.min(a.size, b.size);
  return denominator > 0 && (intersection / denominator) < 0.35;
}

function significantTokens(value) {
  const stop = new Set([
    "bao", "hanh", "thang", "chinh", "hang", "cong", "suat", "dung",
    "tich", "che", "do", "san", "pham", "viet", "nam", "cua", "cho",
    "voi", "the", "va", "mot", "cac"
  ]);
  const normalized = String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ");
  return new Set(
    normalized.split(/\s+/)
      .filter((token) => token.length >= 3 && !stop.has(token))
  );
}

function firstValidPrice(...values) {
  const prices = values.map(validPrice).filter(Boolean);
  return prices.length ? Math.min(...prices) : null;
}

function validPrice(value) {
  if (value === null || value === undefined || value === "") return null;
  let number;
  if (typeof value === "number") {
    number = value;
  } else {
    const raw = String(value).trim();
    const direct = Number(raw);
    number = Number.isFinite(direct)
      ? direct
      : Number(raw.replace(/[^0-9]/g, ""));
  }
  if (!Number.isFinite(number)) return null;
  const rounded = Math.round(number);
  return rounded >= 1000 && rounded <= 2_000_000_000 ? rounded : null;
}

function firstImage(...values) {
  for (const value of values) {
    if (!value) continue;
    try {
      const url = new URL(String(value));
      if (url.protocol === "https:") return url.href;
    } catch {}
  }
  return null;
}

function cleanText(value) {
  return String(value || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function truncate(value, max) {
  const text = String(value || "");
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

function formatVnd(value) {
  return `${new Intl.NumberFormat("vi-VN").format(Number(value))}₫`;
}

function readableError(error) {
  if (error instanceof Error) return error.message;
  return String(error || "Lỗi không xác định");
}

function jsonFrom(sourceResponse, data, status = 200) {
  const headers = new Headers(sourceResponse.headers);
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  return new Response(JSON.stringify(data), { status, headers });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}
