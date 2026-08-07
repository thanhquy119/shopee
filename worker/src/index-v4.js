import { buildPushPayload } from "@block65/webcrypto-web-push";
import baseHandler from "./index-v3.js";

const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8" };
const CHROME_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/api/products" && request.method === "POST") {
      return createProductWithFallback(request, env, ctx, url);
    }

    const checkMatch = url.pathname.match(/^\/api\/products\/([^/]+)\/check$/);
    if (checkMatch && request.method === "POST") {
      return checkProductWithFallback(request, env, ctx, decodeURIComponent(checkMatch[1]));
    }

    return baseHandler.fetch(request, env, ctx);
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(checkAllProductsWithBrowser(env, controller.scheduledTime));
  }
};

async function createProductWithFallback(request, env, ctx, url) {
  const bodyRequest = request.clone();
  const primary = await baseHandler.fetch(request.clone(), env, ctx);
  if (primary.status !== 422) return primary;

  const primaryError = await readError(primary.clone());
  if (!isShopeeFetchFailure(primaryError)) return primary;

  const body = await bodyRequest.json().catch(() => null);
  const rawUrl = String(body?.url || "").trim();
  if (!rawUrl) return primary;

  let product;
  try {
    product = await fetchShopeeProductWithBrowser(rawUrl, env);
  } catch (error) {
    return jsonFrom(primary, {
      error: `${primaryError} | Browser Run: ${readableError(error)}`
    }, 422);
  }

  if (url.searchParams.get("dry_run") === "1") {
    return jsonFrom(primary, { ok: true, dryRun: true, source: "browser-run", product }, 200);
  }

  const result = await upsertTrackedProduct(env, rawUrl, product);
  return jsonFrom(primary, result.data, result.status);
}

async function checkProductWithFallback(request, env, ctx, id) {
  const primary = await baseHandler.fetch(request.clone(), env, ctx);
  if (primary.ok || primary.status === 404 || primary.status === 401) return primary;

  const primaryError = await readError(primary.clone());
  if (!isShopeeFetchFailure(primaryError)) return primary;

  const row = await env.DB.prepare("SELECT * FROM products WHERE id = ? AND active = 1")
    .bind(id)
    .first();
  if (!row) return primary;

  try {
    const checked = await refreshTrackedProductWithBrowser(env, row);
    if (checked.shouldNotify) ctx.waitUntil(notifyPriceDrop(env, checked.product));
    return jsonFrom(primary, {
      ok: true,
      product: checked.product,
      notified: checked.shouldNotify,
      source: "browser-run"
    }, 200);
  } catch (error) {
    return jsonFrom(primary, {
      error: `${primaryError} | Browser Run: ${readableError(error)}`
    }, 502);
  }
}

async function checkAllProductsWithBrowser(env, scheduledTime) {
  const startedAt = new Date(scheduledTime || Date.now()).toISOString();
  const result = await env.DB.prepare(
    "SELECT * FROM products WHERE active = 1 ORDER BY created_at ASC"
  ).all();
  const products = result.results || [];

  console.log(JSON.stringify({
    event: "cron_browser_start",
    startedAt,
    products: products.length
  }));

  for (const row of products) {
    try {
      const checked = await refreshTrackedProductWithBrowser(env, row);
      if (checked.shouldNotify) await notifyPriceDrop(env, checked.product);
    } catch (error) {
      const message = readableError(error).slice(0, 500);
      await env.DB.prepare(
        "UPDATE products SET checked_at = ?, check_error = ? WHERE id = ?"
      ).bind(new Date().toISOString(), message, row.id).run();
      console.error(JSON.stringify({
        event: "browser_product_check_failed",
        productId: row.id,
        error: message
      }));
    }
  }
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
    return { status: 200, data: { ok: true, id, alreadyTracked: true, source: "browser-run" } };
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
    return { status: 200, data: { ok: true, id, restored: true, source: "browser-run" } };
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
  return {
    status: 201,
    data: {
      ok: true,
      id,
      source: "browser-run",
      product: { ...product, baselinePrice: product.price }
    }
  };
}

async function refreshTrackedProductWithBrowser(env, row) {
  const targetUrl = row.url || row.canonical_url;
  const fresh = await fetchShopeeProductWithBrowser(targetUrl, env, {
    shopId: row.shop_id,
    itemId: row.item_id
  });
  const now = new Date().toISOString();
  const oldLowest = Number(row.lowest_price);
  const lowest = Number.isFinite(oldLowest) && oldLowest > 0
    ? Math.min(oldLowest, fresh.price)
    : fresh.price;
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

async function fetchShopeeProductWithBrowser(inputUrl, env, knownIds = null) {
  if (!env.BROWSER?.quickAction) {
    throw new Error("Cloudflare Worker chưa có Browser Run binding.");
  }

  const normalized = normalizeShopeeUrl(inputUrl);
  const resolvedUrl = knownIds ? normalized : await resolveShopeeUrl(normalized);
  const ids = knownIds || parseShopeeIds(resolvedUrl);
  if (!ids?.shopId || !ids?.itemId) {
    throw new Error("Không đọc được shop_id/item_id từ link Shopee này.");
  }

  const canonicalUrl = `https://shopee.vn/product/${ids.shopId}/${ids.itemId}`;
  const targetUrl = isFullShopeeProductUrl(resolvedUrl) ? resolvedUrl : canonicalUrl;
  const failures = [];

  try {
    const response = await env.BROWSER.quickAction("json", {
      url: targetUrl,
      userAgent: CHROME_UA,
      setExtraHTTPHeaders: {
        "Accept-Language": "vi-VN,vi;q=0.9,en-US;q=0.7,en;q=0.6"
      },
      prompt: "Read the main Shopee Vietnam product page. Extract the product name, the CURRENT PUBLIC SELLING PRICE shown for the product before account-specific vouchers, and the main product image URL. If there is a current price range, return the lowest current selectable variant price. Do not use a crossed-out old/original price. Do not use a voucher-only final price. priceVnd must be the whole-number VND amount such as 998000, not 998 or 99800000000. If the page is a captcha, login, access denied, unrelated page, or the price is not visible, return priceVnd as 0 and blocked as true. Never invent a price.",
      response_format: {
        type: "json_schema",
        json_schema: {
          type: "object",
          properties: {
            name: { type: "string" },
            priceVnd: { type: "number" },
            imageUrl: { type: "string" },
            blocked: { type: "boolean" }
          },
          required: ["name", "priceVnd", "imageUrl", "blocked"]
        }
      },
      gotoOptions: { waitUntil: "networkidle2", timeout: 20000 },
      rejectResourceTypes: ["media", "font"]
    });

    if (!response.ok) throw new Error(`JSON HTTP ${response.status}`);
    const payload = await response.json().catch(() => null);
    const data = payload?.result || payload;
    const price = normalizeBrowserPrice(data?.priceVnd);

    if (data?.blocked) throw new Error("Shopee trả trang chặn bot/login thay vì sản phẩm.");
    if (!price) throw new Error("Browser JSON không đọc được giá hiện tại.");

    return {
      shopId: String(ids.shopId),
      itemId: String(ids.itemId),
      canonicalUrl,
      name: cleanText(data?.name) || `Shopee ${ids.shopId}.${ids.itemId}`,
      imageUrl: normalizeImageUrl(data?.imageUrl),
      price
    };
  } catch (error) {
    failures.push(`json: ${readableError(error)}`);
  }

  try {
    const response = await env.BROWSER.quickAction("markdown", {
      url: targetUrl,
      userAgent: CHROME_UA,
      setExtraHTTPHeaders: {
        "Accept-Language": "vi-VN,vi;q=0.9,en-US;q=0.7,en;q=0.6"
      },
      gotoOptions: { waitUntil: "networkidle2", timeout: 20000 },
      rejectResourceTypes: ["media", "font"]
    });
    if (!response.ok) throw new Error(`Markdown HTTP ${response.status}`);

    const payload = await response.json().catch(() => null);
    const markdown = typeof payload?.result === "string"
      ? payload.result
      : (typeof payload === "string" ? payload : "");
    const parsed = parseShopeeMarkdown(markdown, ids, canonicalUrl);
    if (parsed) return parsed;
    throw new Error("Markdown không có giá sản phẩm hợp lệ.");
  } catch (error) {
    failures.push(`markdown: ${readableError(error)}`);
  }

  throw new Error(`Không đọc được giá từ trang sản phẩm. ${failures.join(" | ")}`);
}

function parseShopeeMarkdown(markdown, ids, canonicalUrl) {
  const text = String(markdown || "");
  if (!text || /captcha|access denied|truy cập bị từ chối|đăng nhập để tiếp tục/i.test(text.slice(0, 5000))) {
    return null;
  }

  const nameMatch = text.match(/^#\s+(.{2,300})$/m);
  const name = cleanText(nameMatch?.[1]) || `Shopee ${ids.shopId}.${ids.itemId}`;
  const price = extractFirstVndPrice(text);
  if (!price) return null;

  const imageMatch = text.match(/!\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/i);
  return {
    shopId: String(ids.shopId),
    itemId: String(ids.itemId),
    canonicalUrl,
    name,
    imageUrl: normalizeImageUrl(imageMatch?.[1]),
    price
  };
}

function extractFirstVndPrice(text) {
  const firstPart = String(text || "").slice(0, 12000);
  const patterns = [
    /([0-9]{1,3}(?:[.\s][0-9]{3})+)\s*₫/g,
    /₫\s*([0-9]{1,3}(?:[.\s][0-9]{3})+)/g,
    /([0-9]{4,10})\s*₫/g
  ];

  for (const pattern of patterns) {
    const matches = [...firstPart.matchAll(pattern)];
    for (const match of matches) {
      const price = normalizeBrowserPrice(match[1]);
      if (price) return price;
    }
  }
  return null;
}

function normalizeBrowserPrice(value) {
  if (value === null || value === undefined) return null;
  const numeric = typeof value === "number"
    ? value
    : Number(String(value).replace(/[^0-9]/g, ""));
  if (!Number.isFinite(numeric)) return null;
  const rounded = Math.round(numeric);
  if (rounded < 1000 || rounded > 2_000_000_000) return null;
  return rounded;
}

function normalizeImageUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    return parsed.protocol === "https:" ? parsed.href : null;
  } catch {
    return null;
  }
}

function normalizeShopeeUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Link không hợp lệ.");
  }

  const host = url.hostname.toLowerCase();
  const allowed = host === "shopee.vn" || host.endsWith(".shopee.vn") || host === "vn.shp.ee" || host === "s.shopee.vn";
  if (!allowed) throw new Error("Chỉ hỗ trợ link Shopee Việt Nam.");
  return url.href;
}

async function resolveShopeeUrl(url) {
  const parsed = new URL(url);
  const host = parsed.hostname.toLowerCase();
  if (host !== "vn.shp.ee" && host !== "s.shopee.vn") return url;

  const response = await fetch(url, {
    method: "GET",
    headers: {
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "vi-VN,vi;q=0.9,en-US;q=0.7,en;q=0.6",
      "User-Agent": CHROME_UA
    },
    redirect: "follow"
  });
  if (!response.ok) throw new Error(`Không mở được link rút gọn (HTTP ${response.status}).`);
  return response.url || url;
}

function parseShopeeIds(value) {
  const parsed = new URL(value);
  const path = decodeURIComponent(parsed.pathname || "");
  const iPattern = path.match(/i\.(\d+)\.(\d+)/i);
  if (iPattern) return { shopId: iPattern[1], itemId: iPattern[2] };
  const productPattern = path.match(/\/product\/(\d+)\/(\d+)/i);
  if (productPattern) return { shopId: productPattern[1], itemId: productPattern[2] };
  const allNumbers = path.match(/\d{5,}/g) || [];
  if (allNumbers.length >= 2) return { shopId: allNumbers.at(-2), itemId: allNumbers.at(-1) };
  const shopId = parsed.searchParams.get("shopid") || parsed.searchParams.get("shop_id");
  const itemId = parsed.searchParams.get("itemid") || parsed.searchParams.get("item_id");
  return shopId && itemId ? { shopId, itemId } : null;
}

function isFullShopeeProductUrl(value) {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    if (!(host === "shopee.vn" || host.endsWith(".shopee.vn"))) return false;
    return Boolean(parseShopeeIds(url.href));
  } catch {
    return false;
  }
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
      }
    } catch (error) {
      console.error(JSON.stringify({ event: "push_exception", error: readableError(error) }));
    }
  }
  return sent;
}

async function readError(response) {
  const data = await response.json().catch(() => null);
  return String(data?.error || data?.message || `HTTP ${response.status}`);
}

function isShopeeFetchFailure(message) {
  return /Shopee từ chối|thay đổi API|\/api\/v4\/pdp\/get_pc|\/api\/v4\/item\/get|HTTP 403/i.test(String(message || ""));
}

function jsonFrom(sourceResponse, data, status = 200) {
  const headers = new Headers(sourceResponse.headers);
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  headers.delete("Content-Length");
  return new Response(JSON.stringify(data), { status, headers });
}

function cleanText(value) {
  return String(value || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

function formatVnd(value) {
  return `${new Intl.NumberFormat("vi-VN").format(Number(value))}₫`;
}

function readableError(error) {
  if (error instanceof Error) return error.message;
  return String(error || "Lỗi không xác định");
}
