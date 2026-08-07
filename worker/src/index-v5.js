import { buildPushPayload } from "@block65/webcrypto-web-push";
import coreHandler from "./index-v3.js";
import browserHandler from "./index-v4.js";

const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8" };
const SEARCH_CACHE_TTL = 86400;
const APIFY_ACTOR_ENDPOINT = "https://api.apify.com/v2/acts/xtracto~shopee-scraper/run-sync-get-dataset-items";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/api/search" && request.method === "GET") {
      return stableSearch(request, env, ctx);
    }

    if (url.pathname === "/api/health" && request.method === "GET") {
      const response = await coreHandler.fetch(request, env, ctx);
      if (!response.ok) return response;
      const data = await response.json().catch(() => ({}));
      return json({
        ...data,
        searchCache: true,
        priceFallback: env.APIFY_TOKEN ? "apify" : (env.BROWSER ? "browser" : "none")
      });
    }

    if (url.pathname === "/api/products" && request.method === "POST") {
      return createProductWithApify(request, env, ctx);
    }

    const checkMatch = url.pathname.match(/^\/api\/products\/([^/]+)\/check$/);
    if (checkMatch && request.method === "POST") {
      return checkProductWithApify(request, env, ctx, decodeURIComponent(checkMatch[1]));
    }

    return browserHandler.fetch(request, env, ctx);
  },

  async scheduled(controller, env, ctx) {
    if (env.APIFY_TOKEN) {
      ctx.waitUntil(checkAllProductsWithApify(env, controller.scheduledTime));
      return;
    }
    return browserHandler.scheduled(controller, env, ctx);
  }
};

async function stableSearch(request, env, ctx) {
  const url = new URL(request.url);
  const query = String(url.searchParams.get("q") || "").trim();
  const cacheKey = searchCacheKey(query);
  const live = await coreHandler.fetch(request.clone(), env, ctx);

  if (live.status === 401 || live.status === 403 || !cacheKey) return live;

  if (live.ok) {
    const payload = await live.clone().json().catch(() => null);
    if (Array.isArray(payload?.products) && payload.products.length) {
      await putSearchCache(cacheKey, payload);
      return live;
    }
  }

  const cached = await getSearchCache(cacheKey);
  if (cached) {
    return json({
      ...cached,
      source: `cache:${cached.source || "search"}`,
      cached: true,
      warnings: [
        ...(Array.isArray(cached.warnings) ? cached.warnings : []),
        "Đang dùng kết quả tìm kiếm đã lưu vì nguồn tìm kiếm trực tiếp tạm thời không ổn định."
      ]
    });
  }

  return live;
}

function searchCacheKey(query) {
  const normalized = String(query || "")
    .normalize("NFKC")
    .toLocaleLowerCase("vi")
    .replace(/\s+/g, " ")
    .trim();
  if (normalized.length < 2) return null;
  return new Request(`https://search-cache.shopee-price-watcher.invalid/?q=${encodeURIComponent(normalized)}`);
}

async function putSearchCache(key, payload) {
  try {
    const response = new Response(JSON.stringify(payload), {
      headers: {
        ...JSON_HEADERS,
        "Cache-Control": `public, max-age=${SEARCH_CACHE_TTL}`
      }
    });
    await caches.default.put(key, response);
  } catch (error) {
    console.warn(JSON.stringify({ event: "search_cache_put_failed", error: readableError(error) }));
  }
}

async function getSearchCache(key) {
  try {
    const response = await caches.default.match(key);
    if (!response) return null;
    return await response.json().catch(() => null);
  } catch (error) {
    console.warn(JSON.stringify({ event: "search_cache_get_failed", error: readableError(error) }));
    return null;
  }
}

async function createProductWithApify(request, env, ctx) {
  const bodyRequest = request.clone();
  const primary = await coreHandler.fetch(request.clone(), env, ctx);
  if (primary.ok || primary.status === 401 || primary.status === 403) return primary;

  const primaryError = await readError(primary.clone());
  if (!isShopeeFetchFailure(primaryError)) return primary;

  if (!env.APIFY_TOKEN) {
    return browserHandler.fetch(bodyRequest, env, ctx);
  }

  const body = await bodyRequest.json().catch(() => null);
  const rawUrl = String(body?.url || "").trim();
  if (!rawUrl) return primary;

  try {
    const product = await fetchShopeeProductWithApify(rawUrl, env);
    const result = await upsertTrackedProduct(env, rawUrl, product);
    return jsonFrom(primary, result.data, result.status);
  } catch (error) {
    return jsonFrom(primary, {
      error: `Không lấy được giá Shopee. Apify: ${readableError(error)}`,
      code: "APIFY_PRICE_FAILED"
    }, 422);
  }
}

async function checkProductWithApify(request, env, ctx, id) {
  const primary = await coreHandler.fetch(request.clone(), env, ctx);
  if (primary.ok || primary.status === 401 || primary.status === 403 || primary.status === 404) return primary;

  const primaryError = await readError(primary.clone());
  if (!isShopeeFetchFailure(primaryError)) return primary;

  if (!env.APIFY_TOKEN) {
    return browserHandler.fetch(request, env, ctx);
  }

  const row = await env.DB.prepare("SELECT * FROM products WHERE id = ? AND active = 1")
    .bind(id)
    .first();
  if (!row) return primary;

  try {
    const checked = await refreshTrackedProductWithApify(env, row);
    if (checked.shouldNotify) ctx.waitUntil(notifyPriceDrop(env, checked.product));
    return jsonFrom(primary, {
      ok: true,
      product: checked.product,
      notified: checked.shouldNotify,
      source: "apify"
    }, 200);
  } catch (error) {
    return jsonFrom(primary, {
      error: `Không cập nhật được giá. Apify: ${readableError(error)}`,
      code: "APIFY_PRICE_FAILED"
    }, 502);
  }
}

async function checkAllProductsWithApify(env, scheduledTime) {
  const startedAt = new Date(scheduledTime || Date.now()).toISOString();
  const result = await env.DB.prepare(
    "SELECT * FROM products WHERE active = 1 ORDER BY created_at ASC"
  ).all();
  const products = result.results || [];

  console.log(JSON.stringify({ event: "cron_apify_start", startedAt, products: products.length }));

  for (const row of products) {
    try {
      const checked = await refreshTrackedProductWithApify(env, row);
      if (checked.shouldNotify) await notifyPriceDrop(env, checked.product);
    } catch (error) {
      const message = readableError(error).slice(0, 500);
      await env.DB.prepare(
        "UPDATE products SET checked_at = ?, check_error = ? WHERE id = ?"
      ).bind(new Date().toISOString(), message, row.id).run();
      console.error(JSON.stringify({
        event: "apify_product_check_failed",
        productId: row.id,
        error: message
      }));
    }
  }
}

async function fetchShopeeProductWithApify(inputUrl, env, knownIds = null) {
  const token = String(env.APIFY_TOKEN || "").trim();
  if (!token) throw new Error("Chưa cấu hình APIFY_TOKEN.");

  const ids = knownIds || parseShopeeIds(inputUrl);
  if (!ids?.shopId || !ids?.itemId) {
    throw new Error("Không đọc được shop_id/item_id từ link Shopee.");
  }

  const endpoint = new URL(APIFY_ACTOR_ENDPOINT);
  endpoint.searchParams.set("token", token);
  endpoint.searchParams.set("timeout", "90");

  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      country: "vn",
      mode: "detail",
      shopId: String(ids.shopId),
      itemId: String(ids.itemId),
      maxProducts: 1,
      delay: 0.2
    })
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

  const rows = Array.isArray(payload) ? payload : (Array.isArray(payload?.items) ? payload.items : []);
  if (!rows.length) throw new Error("Actor không trả về sản phẩm.");

  const matching = rows.find((row) =>
    String(row?.shop_id ?? row?.shopId ?? "") === String(ids.shopId) &&
    String(row?.item_id ?? row?.itemId ?? "") === String(ids.itemId)
  ) || rows[0];

  const price = firstValidPrice(
    matching?.price,
    matching?.price_min,
    matching?.priceMin,
    matching?.price_max,
    matching?.priceMax
  );
  if (!price) throw new Error("Actor không trả về giá hợp lệ.");

  const imageUrl = firstImage(
    matching?.image_url,
    matching?.imageUrl,
    matching?.images?.[0]
  );
  const name = cleanText(matching?.title || matching?.name) || `Shopee ${ids.shopId}.${ids.itemId}`;
  const canonicalUrl = `https://shopee.vn/product/${ids.shopId}/${ids.itemId}`;

  return {
    shopId: String(ids.shopId),
    itemId: String(ids.itemId),
    canonicalUrl,
    name,
    imageUrl,
    price
  };
}

function firstValidPrice(...values) {
  const prices = values
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value >= 1000 && value <= 2_000_000_000);
  return prices.length ? Math.round(Math.min(...prices)) : null;
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
    return { status: 200, data: { ok: true, id, alreadyTracked: true, source: "apify" } };
  }

  if (existing) {
    await env.DB.prepare(
      `UPDATE products
          SET url = ?, canonical_url = ?, name = ?, image_url = ?, baseline_price = ?, current_price = ?,
              lowest_price = ?, last_notified_price = NULL, active = 1, created_at = ?, checked_at = ?, check_error = NULL
        WHERE id = ?`
    ).bind(rawUrl, product.canonicalUrl, product.name, product.imageUrl, product.price, product.price, product.price, now, now, id).run();
    await insertHistory(env, id, product.price, now);
    return { status: 200, data: { ok: true, id, restored: true, source: "apify" } };
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
    data: { ok: true, id, source: "apify", product: { ...product, baselinePrice: product.price } }
  };
}

async function refreshTrackedProductWithApify(env, row) {
  const fresh = await fetchShopeeProductWithApify(
    row.canonical_url || row.url,
    env,
    { shopId: row.shop_id, itemId: row.item_id }
  );
  const now = new Date().toISOString();
  const previousLowest = Number(row.lowest_price);
  const lowest = Number.isFinite(previousLowest) && previousLowest > 0
    ? Math.min(previousLowest, fresh.price)
    : fresh.price;
  const shouldNotify = fresh.price < Number(row.baseline_price) &&
    (row.last_notified_price === null || fresh.price < Number(row.last_notified_price));

  await env.DB.prepare(
    `UPDATE products
        SET canonical_url = ?, name = ?, image_url = ?, current_price = ?, lowest_price = ?,
            checked_at = ?, check_error = NULL
      WHERE id = ?`
  ).bind(fresh.canonicalUrl, fresh.name, fresh.imageUrl, fresh.price, lowest, now, row.id).run();

  await insertHistory(env, row.id, fresh.price, now);

  return {
    shouldNotify,
    product: {
      ...row,
      canonical_url: fresh.canonicalUrl,
      name: fresh.name,
      image_url: fresh.imageUrl,
      current_price: fresh.price,
      lowest_price: lowest,
      checked_at: now,
      check_error: null
    }
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

  await recordNotification(env, payload, { type: "price_drop", productId: product.id });
  await env.DB.prepare(
    "UPDATE products SET last_notified_price = ? WHERE id = ?"
  ).bind(product.current_price, product.id).run();
  await sendPushToAll(env, payload);
}

async function recordNotification(env, payload, meta = {}) {
  const createdAt = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO notifications (type, product_id, title, body, url, created_at, read_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL)`
  ).bind(
    meta.type || "price_drop",
    meta.productId || null,
    payload.title,
    payload.body,
    payload.url || null,
    createdAt
  ).run();
}

async function sendPushToAll(env, payload) {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY || !env.VAPID_SUBJECT) return 0;

  const result = await env.DB.prepare(
    "SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE revoked_at IS NULL"
  ).all();
  const subscriptions = result.results || [];
  let sent = 0;

  for (const sub of subscriptions) {
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
      if (response.ok) {
        sent += 1;
      } else if (response.status === 404 || response.status === 410) {
        await env.DB.prepare(
          "UPDATE push_subscriptions SET revoked_at = ? WHERE endpoint = ?"
        ).bind(new Date().toISOString(), sub.endpoint).run();
      }
    } catch (error) {
      console.error(JSON.stringify({ event: "push_exception", endpoint: safeEndpoint(sub.endpoint), error: readableError(error) }));
    }
  }
  return sent;
}

function parseShopeeIds(value) {
  let url;
  try {
    url = new URL(String(value));
  } catch {
    return null;
  }
  const path = decodeURIComponent(url.pathname || "");
  const iPattern = path.match(/i\.(\d+)\.(\d+)/i);
  if (iPattern) return { shopId: iPattern[1], itemId: iPattern[2] };
  const productPattern = path.match(/\/product\/(\d+)\/(\d+)/i);
  if (productPattern) return { shopId: productPattern[1], itemId: productPattern[2] };
  const dottedTail = path.match(/(?:^|\/)(\d+)\.(\d+)(?:\/?$)/);
  if (dottedTail) return { shopId: dottedTail[1], itemId: dottedTail[2] };
  const allNumbers = path.match(/\d{5,}/g) || [];
  if (allNumbers.length >= 2) return { shopId: allNumbers.at(-2), itemId: allNumbers.at(-1) };
  const shopId = url.searchParams.get("shopid") || url.searchParams.get("shop_id");
  const itemId = url.searchParams.get("itemid") || url.searchParams.get("item_id");
  return shopId && itemId ? { shopId, itemId } : null;
}

function isShopeeFetchFailure(message) {
  return /Shopee|HTTP 403|pdp\/get_pc|item\/get|Browser Run|chặn bot|login|429/i.test(String(message || ""));
}

async function readError(response) {
  const data = await response.json().catch(() => null);
  return String(data?.error || data?.message || `HTTP ${response.status}`);
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

function safeEndpoint(endpoint) {
  try { return new URL(endpoint).origin; } catch { return "invalid"; }
}

function readableError(error) {
  if (error instanceof Error) return error.message;
  return String(error || "Lỗi không xác định");
}
