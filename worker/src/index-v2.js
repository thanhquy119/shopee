import { buildPushPayload } from "@block65/webcrypto-web-push";

const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8" };

export default {
  async fetch(request, env, ctx) {
    try {
      if (request.method === "OPTIONS") {
        return corsResponse(request, env, new Response(null, { status: 204 }));
      }

      const url = new URL(request.url);

      if (url.pathname === "/api/config" && request.method === "GET") {
        return corsJson(request, env, { vapidPublicKey: env.VAPID_PUBLIC_KEY || "" });
      }

      if (!isAuthorized(request, env)) {
        return corsJson(request, env, { error: "API key không đúng." }, 401);
      }

      if (url.pathname === "/api/health" && request.method === "GET") {
        return corsJson(request, env, {
          ok: true,
          service: "shopee-price-watcher",
          time: new Date().toISOString()
        });
      }

      if (url.pathname === "/api/products" && request.method === "GET") {
        return listProducts(request, env);
      }
      if (url.pathname === "/api/products" && request.method === "POST") {
        return createProduct(request, env);
      }
      if (url.pathname === "/api/notifications" && request.method === "GET") {
        return listNotifications(request, env, url);
      }
      if (url.pathname === "/api/notifications/read" && request.method === "POST") {
        return markNotificationsRead(request, env);
      }
      if (url.pathname === "/api/push/subscribe" && request.method === "POST") {
        return subscribePush(request, env);
      }
      if (url.pathname === "/api/push/subscribe" && request.method === "DELETE") {
        return unsubscribePush(request, env);
      }
      if (url.pathname === "/api/test-notification" && request.method === "POST") {
        return testPush(request, env, ctx);
      }

      const checkMatch = url.pathname.match(/^\/api\/products\/([^/]+)\/check$/);
      if (checkMatch && request.method === "POST") {
        return checkOne(request, env, decodeURIComponent(checkMatch[1]), ctx);
      }

      const productMatch = url.pathname.match(/^\/api\/products\/([^/]+)$/);
      if (productMatch && request.method === "DELETE") {
        return deleteProduct(request, env, decodeURIComponent(productMatch[1]));
      }

      return corsJson(request, env, { error: "Không tìm thấy endpoint." }, 404);
    } catch (error) {
      console.error("fetch error", error);
      return corsJson(request, env, { error: readableError(error) }, 500);
    }
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(checkAllProducts(env, controller.scheduledTime));
  }
};

function isAuthorized(request, env) {
  if (!env.APP_TOKEN) return false;
  return request.headers.get("Authorization") === `Bearer ${env.APP_TOKEN}`;
}

function allowedOrigin(request, env) {
  const incoming = request.headers.get("Origin");
  const configured = String(env.ALLOWED_ORIGIN || "").trim();
  if (!configured) return incoming || "*";
  return incoming === configured ? incoming : configured;
}

function corsHeaders(request, env) {
  return {
    "Access-Control-Allow-Origin": allowedOrigin(request, env),
    "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Authorization,Content-Type",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin"
  };
}

function corsResponse(request, env, response) {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(corsHeaders(request, env))) {
    headers.set(key, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

function corsJson(request, env, data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...JSON_HEADERS, ...corsHeaders(request, env) }
  });
}

async function listProducts(request, env) {
  const result = await env.DB.prepare(
    `SELECT id, url, canonical_url, shop_id, item_id, name, image_url,
            baseline_price, current_price, lowest_price, last_notified_price,
            active, created_at, checked_at, check_error
       FROM products
      WHERE active = 1
      ORDER BY created_at DESC`
  ).all();
  return corsJson(request, env, { products: result.results || [] });
}

async function createProduct(request, env) {
  const body = await request.json().catch(() => null);
  const rawUrl = body?.url?.trim();
  if (!rawUrl) {
    return corsJson(request, env, { error: "Thiếu link sản phẩm Shopee." }, 400);
  }

  let product;
  try {
    product = await fetchShopeeProduct(rawUrl, env);
  } catch (error) {
    return corsJson(request, env, { error: readableError(error) }, 422);
  }

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
    ).bind(
      rawUrl,
      product.canonicalUrl,
      product.name,
      product.imageUrl,
      product.price,
      product.price,
      now,
      id
    ).run();
    await insertHistory(env, id, product.price, now);
    return corsJson(request, env, { ok: true, id, alreadyTracked: true });
  }

  if (existing) {
    await env.DB.prepare(
      `UPDATE products
          SET url = ?, canonical_url = ?, name = ?, image_url = ?, baseline_price = ?, current_price = ?,
              lowest_price = ?, last_notified_price = NULL, active = 1, created_at = ?, checked_at = ?, check_error = NULL
        WHERE id = ?`
    ).bind(
      rawUrl,
      product.canonicalUrl,
      product.name,
      product.imageUrl,
      product.price,
      product.price,
      product.price,
      now,
      now,
      id
    ).run();
    await insertHistory(env, id, product.price, now);
    return corsJson(request, env, { ok: true, id, restored: true });
  }

  await env.DB.prepare(
    `INSERT INTO products
      (id, url, canonical_url, shop_id, item_id, name, image_url, baseline_price, current_price,
       lowest_price, last_notified_price, active, created_at, checked_at, check_error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 1, ?, ?, NULL)`
  ).bind(
    id,
    rawUrl,
    product.canonicalUrl,
    product.shopId,
    product.itemId,
    product.name,
    product.imageUrl,
    product.price,
    product.price,
    product.price,
    now,
    now
  ).run();

  await insertHistory(env, id, product.price, now);
  return corsJson(request, env, {
    ok: true,
    id,
    product: { ...product, baselinePrice: product.price }
  }, 201);
}

async function deleteProduct(request, env, id) {
  await env.DB.prepare("UPDATE products SET active = 0 WHERE id = ?").bind(id).run();
  return corsJson(request, env, { ok: true });
}

async function checkOne(request, env, id, ctx) {
  const product = await env.DB.prepare("SELECT * FROM products WHERE id = ? AND active = 1")
    .bind(id)
    .first();
  if (!product) {
    return corsJson(request, env, { error: "Không tìm thấy sản phẩm." }, 404);
  }

  const checked = await refreshProduct(env, product);
  if (checked.shouldNotify) {
    ctx.waitUntil(notifyPriceDrop(env, checked.product));
  }
  return corsJson(request, env, {
    ok: true,
    product: checked.product,
    notified: checked.shouldNotify
  });
}

async function checkAllProducts(env, scheduledTime) {
  const startedAt = new Date(scheduledTime || Date.now()).toISOString();
  const result = await env.DB.prepare(
    "SELECT * FROM products WHERE active = 1 ORDER BY created_at ASC"
  ).all();
  const products = result.results || [];
  console.log(JSON.stringify({ event: "cron_start", startedAt, products: products.length }));

  for (const product of products) {
    try {
      const checked = await refreshProduct(env, product);
      if (checked.shouldNotify) {
        await notifyPriceDrop(env, checked.product);
      }
    } catch (error) {
      const message = readableError(error).slice(0, 500);
      await env.DB.prepare(
        "UPDATE products SET checked_at = ?, check_error = ? WHERE id = ?"
      ).bind(new Date().toISOString(), message, product.id).run();
      console.error(JSON.stringify({
        event: "product_check_failed",
        productId: product.id,
        error: message
      }));
    }
  }
}

async function refreshProduct(env, row) {
  const fresh = await fetchShopeeProduct(
    row.canonical_url || row.url,
    env,
    { shopId: row.shop_id, itemId: row.item_id }
  );
  const now = new Date().toISOString();
  const lowest = Math.min(Number(row.lowest_price), fresh.price);
  const shouldNotify = fresh.price < Number(row.baseline_price) &&
    (row.last_notified_price === null || fresh.price < Number(row.last_notified_price));

  await env.DB.prepare(
    `UPDATE products
        SET canonical_url = ?, name = ?, image_url = ?, current_price = ?, lowest_price = ?,
            checked_at = ?, check_error = NULL
      WHERE id = ?`
  ).bind(
    fresh.canonicalUrl,
    fresh.name,
    fresh.imageUrl,
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

async function listNotifications(request, env, url) {
  const requestedLimit = Number(url.searchParams.get("limit") || 60);
  const limit = Math.max(1, Math.min(100, Number.isFinite(requestedLimit) ? requestedLimit : 60));

  const [items, unread] = await Promise.all([
    env.DB.prepare(
      `SELECT id, type, product_id, title, body, url, created_at, read_at
         FROM notifications
        ORDER BY created_at DESC
        LIMIT ?`
    ).bind(limit).all(),
    env.DB.prepare(
      "SELECT COUNT(*) AS count FROM notifications WHERE read_at IS NULL"
    ).first()
  ]);

  return corsJson(request, env, {
    notifications: items.results || [],
    unreadCount: Number(unread?.count || 0)
  });
}

async function markNotificationsRead(request, env) {
  const now = new Date().toISOString();
  await env.DB.prepare(
    "UPDATE notifications SET read_at = ? WHERE read_at IS NULL"
  ).bind(now).run();
  return corsJson(request, env, { ok: true, readAt: now });
}

async function recordNotification(env, payload, meta = {}) {
  const createdAt = new Date().toISOString();
  const result = await env.DB.prepare(
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
  return { id: result.meta?.last_row_id || null, createdAt };
}

async function fetchShopeeProduct(inputUrl, env, knownIds = null) {
  const normalized = normalizeUrl(inputUrl);
  const resolvedUrl = knownIds ? normalized : await resolveShopeeUrl(normalized);
  const ids = knownIds || parseShopeeIds(resolvedUrl);
  if (!ids?.shopId || !ids?.itemId) {
    throw new Error("Không đọc được shop_id/item_id từ link Shopee này.");
  }

  const canonicalUrl = `https://shopee.vn/product/${ids.shopId}/${ids.itemId}`;
  const endpoints = [
    `https://shopee.vn/api/v4/pdp/get_pc?item_id=${encodeURIComponent(ids.itemId)}&shop_id=${encodeURIComponent(ids.shopId)}`,
    `https://shopee.vn/api/v4/item/get?itemid=${encodeURIComponent(ids.itemId)}&shopid=${encodeURIComponent(ids.shopId)}`
  ];

  const failures = [];
  for (const endpoint of endpoints) {
    try {
      const response = await fetch(endpoint, {
        headers: shopeeHeaders(canonicalUrl, env),
        redirect: "follow"
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const payload = await response.json();
      if (payload?.error || payload?.error_msg) {
        throw new Error(payload.error_msg || `Shopee error ${payload.error}`);
      }

      const parsed = parseShopeePayload(payload, ids, canonicalUrl);
      if (parsed) return parsed;
      throw new Error("Không tìm thấy giá trong dữ liệu Shopee.");
    } catch (error) {
      failures.push(`${new URL(endpoint).pathname}: ${readableError(error)}`);
    }
  }

  throw new Error(`Shopee từ chối hoặc thay đổi API. ${failures.join(" | ")}`);
}

function shopeeHeaders(referer, env) {
  const headers = {
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "vi-VN,vi;q=0.9,en-US;q=0.7,en;q=0.6",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
    "Referer": referer,
    "x-api-source": "pc",
    "af-ac-enc-dat": "1"
  };
  if (env.SHOPEE_COOKIE) headers.Cookie = env.SHOPEE_COOKIE;
  return headers;
}

function parseShopeePayload(payload, ids, canonicalUrl) {
  const data = payload?.data;
  const item = data?.item || data?.item_basic || payload?.item || data;
  if (!item || typeof item !== "object") return null;

  const modernPrice = data?.product_price?.price;
  const priceCandidates = [
    modernPrice?.single_value,
    modernPrice?.range_min,
    item.price,
    item.price_min,
    data?.price,
    data?.price_min
  ].map(Number).filter((value) => Number.isFinite(value) && value > 0);

  const modelPrices = (item.models || data?.models || [])
    .filter((model) => model && model.stock !== 0 && model.status !== 0)
    .flatMap((model) => [Number(model.price), Number(model.price_min)])
    .filter((value) => Number.isFinite(value) && value > 0);

  const rawPrice = modelPrices.length
    ? Math.min(...modelPrices)
    : (priceCandidates.length ? Math.min(...priceCandidates) : null);
  if (!rawPrice) return null;

  const price = normalizeShopeePrice(rawPrice);
  if (!Number.isFinite(price) || price <= 0) return null;

  const imageValue = item.image ||
    item.image_hash ||
    item.images?.[0] ||
    data?.product_images?.images?.[0] ||
    data?.image;

  const imageUrl = imageValue
    ? (String(imageValue).startsWith("http")
      ? String(imageValue)
      : `https://down-vn.img.susercontent.com/file/${imageValue}`)
    : null;

  return {
    shopId: String(ids.shopId),
    itemId: String(ids.itemId),
    canonicalUrl,
    name: item.name || item.title || data?.name || data?.title || `Shopee ${ids.shopId}.${ids.itemId}`,
    imageUrl,
    price
  };
}

function normalizeShopeePrice(raw) {
  return Math.round(Number(raw) / 100000);
}

function normalizeUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Link không hợp lệ.");
  }

  const host = url.hostname.toLowerCase();
  const isShopeeVn = host === "shopee.vn" || host.endsWith(".shopee.vn");
  const isShopeeShort = host === "vn.shp.ee";
  if (!isShopeeVn && !isShopeeShort) {
    throw new Error("Hiện bản này chỉ nhận link Shopee Việt Nam hoặc link rút gọn vn.shp.ee.");
  }
  return url.href;
}

async function resolveShopeeUrl(url) {
  const parsed = new URL(url);
  const host = parsed.hostname.toLowerCase();
  const isShort = host === "s.shopee.vn" || host === "vn.shp.ee";
  if (!isShort) return url;

  const response = await fetch(url, {
    method: "GET",
    headers: {
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "vi-VN,vi;q=0.9,en-US;q=0.7,en;q=0.6",
      "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 Version/18.5 Mobile/15E148 Safari/604.1"
    },
    redirect: "follow"
  });

  if (!response.ok) {
    throw new Error(`Không mở được link rút gọn Shopee (HTTP ${response.status}).`);
  }

  const resolved = response.url || url;
  const finalHost = new URL(resolved).hostname.toLowerCase();
  if (!(finalHost === "shopee.vn" || finalHost.endsWith(".shopee.vn"))) {
    throw new Error("Link rút gọn không chuyển đến trang sản phẩm Shopee Việt Nam.");
  }
  return resolved;
}

function parseShopeeIds(url) {
  const parsed = new URL(url);
  const path = decodeURIComponent(parsed.pathname);

  const iPattern = path.match(/i\.(\d+)\.(\d+)/i);
  if (iPattern) return { shopId: iPattern[1], itemId: iPattern[2] };

  const productPattern = path.match(/\/product\/(\d+)\/(\d+)/i);
  if (productPattern) return { shopId: productPattern[1], itemId: productPattern[2] };

  const dottedTail = path.match(/(?:^|\/)(\d+)\.(\d+)(?:\/?$)/);
  if (dottedTail) return { shopId: dottedTail[1], itemId: dottedTail[2] };

  const allNumbers = path.match(/\d{5,}/g) || [];
  if (allNumbers.length >= 2) {
    return { shopId: allNumbers.at(-2), itemId: allNumbers.at(-1) };
  }

  const shopId = parsed.searchParams.get("shopid") || parsed.searchParams.get("shop_id");
  const itemId = parsed.searchParams.get("itemid") || parsed.searchParams.get("item_id");
  return shopId && itemId ? { shopId, itemId } : null;
}

async function subscribePush(request, env) {
  const sub = await request.json().catch(() => null);
  const endpoint = sub?.endpoint;
  const p256dh = sub?.keys?.p256dh;
  const auth = sub?.keys?.auth;
  if (!endpoint || !p256dh || !auth) {
    return corsJson(request, env, { error: "Push subscription không hợp lệ." }, 400);
  }

  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO push_subscriptions (endpoint, p256dh, auth, created_at, revoked_at)
     VALUES (?, ?, ?, ?, NULL)
     ON CONFLICT(endpoint) DO UPDATE SET
       p256dh = excluded.p256dh,
       auth = excluded.auth,
       revoked_at = NULL`
  ).bind(endpoint, p256dh, auth, now).run();

  return corsJson(request, env, { ok: true });
}

async function unsubscribePush(request, env) {
  const body = await request.json().catch(() => null);
  if (!body?.endpoint) {
    return corsJson(request, env, { error: "Thiếu endpoint." }, 400);
  }

  await env.DB.prepare(
    "UPDATE push_subscriptions SET revoked_at = ? WHERE endpoint = ?"
  ).bind(new Date().toISOString(), body.endpoint).run();

  return corsJson(request, env, { ok: true });
}

async function testPush(request, env, ctx) {
  const payload = {
    title: "S. — Thông báo hoạt động",
    body: "Web Push đã kết nối thành công.",
    url: env.ALLOWED_ORIGIN || "/",
    tag: `test-${Date.now()}`
  };

  await recordNotification(env, payload, { type: "test" });
  ctx.waitUntil(sendPushToAll(env, payload));
  return corsJson(request, env, { ok: true });
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
    url: product.canonical_url || env.ALLOWED_ORIGIN || "/",
    tag: `price-${product.id}-${product.current_price}`
  };

  await recordNotification(env, payload, {
    type: "price_drop",
    productId: product.id
  });

  await env.DB.prepare(
    "UPDATE products SET last_notified_price = ? WHERE id = ?"
  ).bind(product.current_price, product.id).run();

  await sendPushToAll(env, payload);
}

async function sendPushToAll(env, payload) {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY || !env.VAPID_SUBJECT) {
    console.warn("VAPID secrets are not configured; notification kept in D1 only.");
    return 0;
  }

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
      } else {
        console.warn(JSON.stringify({
          event: "push_failed",
          status: response.status,
          endpoint: safeEndpoint(sub.endpoint)
        }));
      }
    } catch (error) {
      console.error(JSON.stringify({
        event: "push_exception",
        endpoint: safeEndpoint(sub.endpoint),
        error: readableError(error)
      }));
    }
  }

  return sent;
}

function safeEndpoint(endpoint) {
  try {
    return new URL(endpoint).origin;
  } catch {
    return "invalid";
  }
}

function formatVnd(value) {
  return `${new Intl.NumberFormat("vi-VN").format(Number(value))}₫`;
}

function readableError(error) {
  if (error instanceof Error) return error.message;
  return String(error || "Lỗi không xác định");
}