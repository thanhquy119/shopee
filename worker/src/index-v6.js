import stableHandler from "./index-v5.js";

const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8" };
const SEARCH_CACHE_TTL = 86400;
const APIFY_ACTOR_ENDPOINT = "https://api.apify.com/v2/acts/xtracto~shopee-scraper/run-sync-get-dataset-items";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/api/search" && request.method === "GET") {
      return searchWithPreferredProvider(request, env, ctx);
    }

    if (url.pathname === "/api/health" && request.method === "GET") {
      const response = await stableHandler.fetch(request, env, ctx);
      if (!response.ok) return response;
      const data = await response.json().catch(() => ({}));
      return json({
        ...data,
        searchProvider: env.APIFY_TOKEN ? "apify+cache" : "free+cache"
      });
    }

    return stableHandler.fetch(request, env, ctx);
  },

  async scheduled(controller, env, ctx) {
    return stableHandler.scheduled(controller, env, ctx);
  }
};

async function searchWithPreferredProvider(request, env, ctx) {
  const url = new URL(request.url);
  const query = String(url.searchParams.get("q") || "").trim();
  if (query.length < 2) return stableHandler.fetch(request, env, ctx);

  const authProbe = new Request(new URL("/api/health", request.url), {
    method: "GET",
    headers: {
      Authorization: request.headers.get("Authorization") || ""
    }
  });
  const authResponse = await stableHandler.fetch(authProbe, env, ctx);
  if (!authResponse.ok) return authResponse;

  const cacheKey = searchCacheKey(query);
  const cached = await getSearchCache(cacheKey);
  if (cached) {
    return json({
      ...cached,
      source: `cache:${cached.source || "search"}`,
      cached: true
    });
  }

  if (env.APIFY_TOKEN) {
    try {
      const products = await searchShopeeWithApify(query, env);
      if (products.length) {
        const payload = {
          query,
          products,
          count: products.length,
          source: "apify-search",
          fallbackUrl: `https://shopee.vn/search?keyword=${encodeURIComponent(query)}`,
          warnings: []
        };
        await putSearchCache(cacheKey, payload);
        return json(payload);
      }
    } catch (error) {
      console.warn(JSON.stringify({ event: "apify_search_failed", error: readableError(error) }));
    }
  }

  const fallback = await stableHandler.fetch(request, env, ctx);
  if (fallback.ok) {
    const payload = await fallback.clone().json().catch(() => null);
    if (Array.isArray(payload?.products) && payload.products.length) {
      await putSearchCache(cacheKey, payload);
    }
  }
  return fallback;
}

async function searchShopeeWithApify(query, env) {
  const token = String(env.APIFY_TOKEN || "").trim();
  if (!token) return [];

  const endpoint = new URL(APIFY_ACTOR_ENDPOINT);
  endpoint.searchParams.set("token", token);
  endpoint.searchParams.set("timeout", "90");

  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      country: "vn",
      mode: "keyword",
      keyword: query.slice(0, 160),
      sort: "relevancy",
      maxProducts: 12,
      fetchDetail: false,
      delay: 0.2
    })
  });

  const text = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${truncate(text, 180)}`);

  let rows;
  try {
    const payload = JSON.parse(text);
    rows = Array.isArray(payload) ? payload : (Array.isArray(payload?.items) ? payload.items : []);
  } catch {
    throw new Error("Apify không trả JSON hợp lệ.");
  }

  const products = rows
    .map(mapApifySearchProduct)
    .filter(Boolean)
    .sort((a, b) => relevanceScore(b, query) - relevanceScore(a, query));

  const seen = new Set();
  return products.filter((product) => {
    const key = `${product.shopId}:${product.itemId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 12);
}

function mapApifySearchProduct(row) {
  if (!row || typeof row !== "object") return null;
  const shopId = String(row.shop_id ?? row.shopId ?? "").trim();
  const itemId = String(row.item_id ?? row.itemId ?? "").trim();
  if (!/^\d+$/.test(shopId) || !/^\d+$/.test(itemId)) return null;

  const name = cleanText(row.name || row.title) || `Shopee ${shopId}.${itemId}`;
  const sourceUrl = normalizeShopeeUrl(row.url) || `https://shopee.vn/product/${shopId}/${itemId}`;
  const price = validPrice(row.price);
  const priceMax = validPrice(row.price_max ?? row.priceMax);
  const original = validPrice(row.original_price ?? row.originalPrice);
  const discountRaw = Number(row.discount_pct ?? row.discountPercent);

  return {
    shopId,
    itemId,
    name,
    imageUrl: firstImage(row.image_url, row.imageUrl, row.images?.[0]),
    priceMin: price,
    priceMax: priceMax && price && priceMax > price ? priceMax : null,
    discount: Number.isFinite(discountRaw) && discountRaw > 0 ? `-${Math.round(discountRaw)}%` : null,
    rating: numberOrNull(row.rating ?? row.rating_star),
    sold: numberOrNull(row.sold_count ?? row.sold),
    shopLocation: cleanText(row.location || row.shop_location) || "Shopee Việt Nam",
    url: `https://shopee.vn/product/${shopId}/${itemId}`,
    sourceUrl,
    originalPrice: original
  };
}

function relevanceScore(product, query) {
  const name = normalizeText(product.name);
  const normalizedQuery = normalizeText(query);
  let score = 0;

  if (name === normalizedQuery) score += 500;
  if (name.includes(normalizedQuery)) score += 250;

  const modelTokens = String(query).toUpperCase().match(/[A-Z]{1,10}[A-Z0-9]*[-/][A-Z0-9/-]{2,}|[A-Z]{2,}[A-Z0-9-]*\d[A-Z0-9-]*/g) || [];
  for (const token of modelTokens) {
    if (product.name.toUpperCase().includes(token)) score += 180;
    else score -= 80;
  }

  const words = normalizedQuery.split(" ").filter((word) => word.length >= 3);
  for (const word of words) {
    if (name.includes(word)) score += 8;
  }

  return score;
}

function searchCacheKey(query) {
  const normalized = normalizeText(query);
  return new Request(`https://search-cache.shopee-price-watcher.invalid/v2?q=${encodeURIComponent(normalized)}`);
}

async function putSearchCache(key, payload) {
  try {
    await caches.default.put(key, new Response(JSON.stringify(payload), {
      headers: {
        ...JSON_HEADERS,
        "Cache-Control": `public, max-age=${SEARCH_CACHE_TTL}`
      }
    }));
  } catch (error) {
    console.warn(JSON.stringify({ event: "search_v2_cache_put_failed", error: readableError(error) }));
  }
}

async function getSearchCache(key) {
  try {
    const response = await caches.default.match(key);
    return response ? await response.json().catch(() => null) : null;
  } catch {
    return null;
  }
}

function normalizeText(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLocaleLowerCase("vi")
    .replace(/[^\p{L}\p{N}/-]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeShopeeUrl(value) {
  if (!value) return null;
  try {
    const url = new URL(String(value));
    const host = url.hostname.toLowerCase();
    if (host === "shopee.vn" || host.endsWith(".shopee.vn")) return url.href;
  } catch {}
  return null;
}

function validPrice(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 1000 && number <= 2_000_000_000
    ? Math.round(number)
    : null;
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
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

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

function readableError(error) {
  if (error instanceof Error) return error.message;
  return String(error || "Lỗi không xác định");
}
