import { buildPushPayload } from "@block65/webcrypto-web-push";
import baseHandler from "./index-v6.js";

const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8" };
const APIFY_ACTOR_ENDPOINT = "https://api.apify.com/v2/acts/xtracto~shopee-scraper/run-sync-get-dataset-items";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/api/health" && request.method === "GET") {
      const response = await baseHandler.fetch(request, env, ctx);
      if (!response.ok) return response;
      const data = await response.json().catch(() => ({}));
      return json({
        ...data,
        priceTracking: "search-card-hint+daily-apify",
        checkCadence: "daily-00:05-Asia/Ho_Chi_Minh"
      });
    }

    if (url.pathname === "/api/products" && request.method === "POST") {
      const auth = await authorizeThroughBase(request, env, ctx);
      if (!auth.ok) return auth;
      return createProduct(request, env, auth);
    }

    const checkMatch = url.pathname.match(/^\/api\/products\/([^/]+)\/check$/);
    if (checkMatch && request.method === "POST") {
      const auth = await authorizeThroughBase(request, env, ctx);
      if (!auth.ok) return auth;
      return checkProduct(env, decodeURIComponent(checkMatch[1]), ctx, auth);
    }

    return baseHandler.fetch(request, env, ctx);
  },

  async scheduled(controller, env, ctx) {
    if (!env.APIFY_TOKEN) return baseHandler.scheduled(controller, env, ctx);
    ctx.waitUntil(checkAllProducts(env, controller.scheduledTime));
  }
};

async function authorizeThroughBase(request, env, ctx) {
  const probe = new Request(new URL("/api/health", request.url), {
    method: "GET",
    headers: { Authorization: request.headers.get("Authorization") || "" }
  });
  return baseHandler.fetch(probe, env, ctx);
}

async function createProduct(request, env, authResponse) {
  const body = await request.json().catch(() => null);
  const rawUrl = String(body?.url || "").trim();
  if (!rawUrl) return jsonFrom(authResponse, { error: "Thiếu link sản phẩm Shopee." }, 400);

  const ids = parseShopeeIds(rawUrl);
  if (!ids) {
    return jsonFrom(authResponse, { error: "Không đọc được shop_id/item_id từ sản phẩm đã chọn." }, 422);
  }

  const hint = normalizeProductHint(body?.productHint, ids);
  let product = hint?.price ? productFromHint(hint, ids) : null;

  if (!product) {
    if (!env.APIFY_TOKEN) {
      return jsonFrom(authResponse, { error: "Chưa có APIFY_TOKEN để lấy giá sản phẩm." }, 422);
    }
    try {
      product = await fetchProductPrice(env, ids, hint?.name || nameFromUrl(rawUrl));
    } catch (error) {
      return jsonFrom(authResponse, {
        error: `Không lấy được giá Shopee. Apify: ${readableError(error)}`,
        code: "APIFY_PRICE_FAILED"
      }, 422);
    }
  }

  const result = await upsertTrackedProduct(env, rawUrl, product);
  return jsonFrom(authResponse, result.data, result.status);
}

async function checkProduct(env, id, ctx, authResponse) {
  const row = await env.DB.prepare("SELECT * FROM products WHERE id = ? AND active = 1")
    .bind(id)
    .first();
  if (!row) return jsonFrom(authResponse, { error: "Không tìm thấy sản phẩm." }, 404);

  try {
    const checked = await refreshTrackedProduct(env, row);
    if (checked.shouldNotify) ctx.waitUntil(notifyPriceDrop(env, checked.product));
    return jsonFrom(authResponse, {
      ok: true,
      product: checked.product,
      notified: checked.shouldNotify,
      source: "apify-keyword"
    });
  } catch (error) {
    return jsonFrom(authResponse, {
      error: `Không cập nhật được giá. Apify: ${readableError(error)}`,
      code: "APIFY_PRICE_FAILED"
    }, 502);
  }
}

async function checkAllProducts(env, scheduledTime) {
  const startedAt = new Date(scheduledTime || Date.now()).toISOString();
  const result = await env.DB.prepare(
    "SELECT * FROM products WHERE active = 1 ORDER BY created_at ASC"
  ).all();
  const products = result.results || [];

  console.log(JSON.stringify({ event: "daily_apify_start", startedAt, products: products.length }));

  for (const row of products) {
    try {
      const checked = await refreshTrackedProduct(env, row);
      if (checked.shouldNotify) await notifyPriceDrop(env, checked.product);
    } catch (error) {
      const message = readableError(error).slice(0, 500);
      await env.DB.prepare(
        "UPDATE products SET checked_at = ?, check_error = ? WHERE id = ?"
      ).bind(new Date().toISOString(), message, row.id).run();
      console.error(JSON.stringify({ event: "daily_apify_failed", productId: row.id, error: message }));
    }
  }
}

async function refreshTrackedProduct(env, row) {
  const ids = { shopId: String(row.shop_id), itemId: String(row.item_id) };
  const fresh = await fetchProductPrice(env, ids, row.name || nameFromUrl(row.url || row.canonical_url));
  const now = new Date().toISOString();
  const previousLowest = validPrice(row.lowest_price);
  const lowest = previousLowest ? Math.min(previousLowest, fresh.price) : fresh.price;
  const shouldNotify = fresh.price < Number(row.baseline_price) &&
    (row.last_notified_price === null || fresh.price < Number(row.last_notified_price));

  await env.DB.prepare(
    `UPDATE products
        SET canonical_url = ?, name = ?, image_url = ?, current_price = ?, lowest_price = ?,
            checked_at = ?, check_error = NULL
      WHERE id = ?`
  ).bind(
    fresh.canonicalUrl,
    fresh.name || row.name,
    fresh.imageUrl || row.image_url,
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
      canonical_url: fresh.canonicalUrl,
      name: fresh.name || row.name,
      image_url: fresh.imageUrl || row.image_url,
      current_price: fresh.price,
      lowest_price: lowest,
      checked_at: now,
      check_error: null
    }
  };
}

async function fetchProductPrice(env, ids, keywordHint = "") {
  const token = String(env.APIFY_TOKEN || "").trim();
  if (!token) throw new Error("Chưa cấu hình APIFY_TOKEN.");

  const keyword = cleanText(keywordHint).slice(0, 160);
  if (keyword.length >= 2) {
    const rows = await runApify(env, {
      country: "vn",
      mode: "keyword",
      keyword,
      sort: "relevancy",
      maxProducts: 6,
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

  const detail = findByIds(detailRows, ids) || detailRows[0];
  const parsed = mapApifyProduct(detail, ids);
  if (parsed?.price) return parsed;

  throw new Error("Không tìm thấy giá của đúng shop_id/item_id trong kết quả Actor.");
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
    throw new Error(`HTTP ${response.status}${text ? `: ${truncate(text, 180)}` : ""}`);
  }

  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error("Apify không trả JSON hợp lệ.");
  }

  return Array.isArray(payload) ? payload : (Array.isArray(payload?.items) ? payload.items : []);
}

function findByIds(rows, ids) {
  return (rows || []).find((row) =>
    String(row?.shop_id ?? row?.shopId ?? "") === String(ids.shopId) &&
    String(row?.item_id ?? row?.itemId ?? "") === String(ids.itemId)
  ) || null;
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
    name: cleanText(row.name || row.title) || `Shopee ${ids.shopId}.${ids.itemId}`,
    imageUrl: firstImage(row.image_url, row.imageUrl, row.images?.[0]),
    price
  };
}

function normalizeProductHint(hint, ids) {
  if (!hint || typeof hint !== "object") return null;
  const shopId = String(hint.shopId ?? hint.shop_id ?? "");
  const itemId = String(hint.itemId ?? hint.item_id ?? "");
  if (shopId !== String(ids.shopId) || itemId !== String(ids.itemId)) return null;
  return {
    shopId,
    itemId,
    name: cleanText(hint.name),
    imageUrl: firstImage(hint.imageUrl, hint.image_url),
    price: validPrice(hint.price)
  };
}

function productFromHint(hint, ids) {
  return {
    shopId: String(ids.shopId),
    itemId: String(ids.itemId),
    canonicalUrl: `https://shopee.vn/product/${ids.shopId}/${ids.itemId}`,
    name: hint.name || `Shopee ${ids.shopId}.${ids.itemId}`,
    imageUrl: hint.imageUrl || null,
    price: hint.price
  };
}

async function upsertTrackedProduct(env, rawUrl, product) {
  const id = `${product.shopId}:${product.itemId}`;
  const now = new Date().toISOString();
  const existing = await env.DB.prepare("SELECT id, active FROM products WHERE id = ?")
    .bind(id)
    .first();

  if (existing?.active) {
    await env.DB.prepare(
      `UPDATE products
          SET url = ?, canonical_url = ?, name = ?, image_url = ?, current_price = ?,
              lowest_price = MIN(lowest_price, ?), checked_at = ?, check_error = NULL
        WHERE id = ?`
    ).bind(rawUrl, product.canonicalUrl, product.name, product.imageUrl, product.price, product.price, now, id).run();
    await insertHistory(env, id, product.price, now);
    return { status: 200, data: { ok: true, id, alreadyTracked: true, source: "search-price" } };
  }

  if (existing) {
    await env.DB.prepare(
      `UPDATE products
          SET url = ?, canonical_url = ?, name = ?, image_url = ?, baseline_price = ?, current_price = ?,
              lowest_price = ?, last_notified_price = NULL, active = 1, created_at = ?, checked_at = ?, check_error = NULL
        WHERE id = ?`
    ).bind(rawUrl, product.canonicalUrl, product.name, product.imageUrl, product.price, product.price, product.price, now, now, id).run();
    await insertHistory(env, id, product.price, now);
    return { status: 200, data: { ok: true, id, restored: true, source: "search-price" } };
  }

  await env.DB.prepare(
    `INSERT INTO products
      (id, url, canonical_url, shop_id, item_id, name, image_url, baseline_price, current_price,
       lowest_price, last_notified_price, active, created_at, checked_at, check_error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 1, ?, ?, NULL)`
  ).bind(
    id, rawUrl, product.canonicalUrl, product.shopId, product.itemId,
    product.name, product.imageUrl, product.price, product.price, product.price, now, now
  ).run();

  await insertHistory(env, id, product.price, now);
  return {
    status: 201,
    data: { ok: true, id, source: "search-price", product: { ...product, baselinePrice: product.price } }
  };
}

async function insertHistory(env, productId, price, checkedAt) {
  await env.DB.prepare(
    "INSERT INTO price_history (product_id, price, checked_at) VALUES (?, ?, ?)"
  ).bind(productId, price, checkedAt).run();
}

async function notifyPriceDrop(env, product) {
  const drop = Number(product.baseline_price) - Number(product.current_price);
  const percent = Math.max(1, Math.round((drop / Number(product.baseline_price)) * 100));
  const payload = {
    title: `S. — Giá giảm ${percent}%`,
    body: `${product.name}: ${formatVnd(product.current_price)} (ban đầu ${formatVnd(product.baseline_price)})`,
    url: product.canonical_url || env.ALLOWED_ORIGIN || "/",
    tag: `price-${product.id}-${product.current_price}`
  };

  await recordNotification(env, payload, product.id);
  await env.DB.prepare(
    "UPDATE products SET last_notified_price = ? WHERE id = ?"
  ).bind(product.current_price, product.id).run();
  await sendPushToAll(env, payload);
}

async function recordNotification(env, payload, productId) {
  await env.DB.prepare(
    `INSERT INTO notifications (type, product_id, title, body, url, created_at, read_at)
     VALUES ('price_drop', ?, ?, ?, ?, ?, NULL)`
  ).bind(productId, payload.title, payload.body, payload.url || null, new Date().toISOString()).run();
}

async function sendPushToAll(env, payload) {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY || !env.VAPID_SUBJECT) return 0;
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
        {
          subject: env.VAPID_SUBJECT,
          publicKey: env.VAPID_PUBLIC_KEY,
          privateKey: env.VAPID_PRIVATE_KEY
        }
      );
      const response = await fetch(sub.endpoint, init);
      if (response.ok) sent += 1;
      else if (response.status === 404 || response.status === 410) {
        await env.DB.prepare(
          "UPDATE push_subscriptions SET revoked_at = ? WHERE endpoint = ?"
        ).bind(new Date().toISOString(), sub.endpoint).run();
      }
    } catch (error) {
      console.error(JSON.stringify({ event: "push_exception", error: readableError(error) }));
    }
  }
  return sent;
}

function parseShopeeIds(value) {
  let url;
  try { url = new URL(String(value)); } catch { return null; }
  const path = decodeURIComponent(url.pathname || "");
  const product = path.match(/\/product\/(\d+)\/(\d+)/i);
  if (product) return { shopId: product[1], itemId: product[2] };
  const named = path.match(/i\.(\d+)\.(\d+)/i);
  if (named) return { shopId: named[1], itemId: named[2] };
  const allNumbers = path.match(/\d{5,}/g) || [];
  if (allNumbers.length >= 2) return { shopId: allNumbers.at(-2), itemId: allNumbers.at(-1) };
  return null;
}

function nameFromUrl(value) {
  try {
    const path = decodeURIComponent(new URL(String(value)).pathname || "");
    const slug = path.split("/").filter(Boolean).at(-1) || "";
    return cleanText(slug.replace(/-i\.\d+\.\d+.*$/i, "").replace(/-/g, " "));
  } catch {
    return "";
  }
}

function firstValidPrice(...values) {
  const prices = values.map(validPrice).filter(Boolean);
  return prices.length ? Math.min(...prices) : null;
}

function validPrice(value) {
  if (value === null || value === undefined || value === "") return null;
  let number;
  if (typeof value === "number") number = value;
  else {
    const raw = String(value).trim();
    const direct = Number(raw);
    number = Number.isFinite(direct) ? direct : Number(raw.replace(/[^0-9]/g, ""));
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
  return String(value || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
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
