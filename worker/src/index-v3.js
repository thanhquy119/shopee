import { createRemoteJWKSet, decodeJwt, jwtVerify } from "jose";
import baseHandler from "./index-v2.js";

const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8" };
const BRAVE_SEARCH_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";
const GLOBAL_VERCEL_ISSUER = "https://oidc.vercel.com";
const jwksByIssuer = new Map();

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/api/config" && request.method === "GET") {
      return baseHandler.fetch(request, env, ctx);
    }

    const auth = await authorizeRequest(request, env);
    if (!auth) return json({ error: "Không xác thực được yêu cầu từ ứng dụng." }, 401);

    if (url.pathname === "/api/health" && request.method === "GET") {
      return json({
        ok: true,
        service: "shopee-price-watcher",
        auth: auth.mode,
        browserFallback: Boolean(env.BROWSER),
        time: new Date().toISOString()
      });
    }

    if (url.pathname === "/api/search" && request.method === "GET") {
      try {
        return await searchShopee(env, url);
      } catch (error) {
        console.error("search error", error);
        return json({ error: readableError(error), code: "PRODUCT_SEARCH_FAILED" }, 502);
      }
    }

    if (auth.mode === "oidc") {
      const delegatedEnv = Object.create(env);
      delegatedEnv.APP_TOKEN = auth.token;
      return baseHandler.fetch(request, delegatedEnv, ctx);
    }

    return baseHandler.fetch(request, env, ctx);
  },

  async scheduled(controller, env, ctx) {
    return baseHandler.scheduled(controller, env, ctx);
  }
};

async function authorizeRequest(request, env) {
  const authorization = String(request.headers.get("Authorization") || "");
  if (!authorization.startsWith("Bearer ")) return null;
  const token = authorization.slice(7).trim();
  if (!token) return null;

  if (env.APP_TOKEN && token === String(env.APP_TOKEN)) return { mode: "legacy", token };
  if (await verifyVercelOidc(token, env)) return { mode: "oidc", token };
  return null;
}

async function verifyVercelOidc(token, env) {
  try {
    const unverified = decodeJwt(token);
    const issuer = String(unverified.iss || "").replace(/\/$/, "");
    const teamIssuer = String(env.VERCEL_OIDC_ISSUER || "").replace(/\/$/, "");
    const allowedIssuers = new Set([teamIssuer, GLOBAL_VERCEL_ISSUER].filter(Boolean));
    if (!allowedIssuers.has(issuer)) return false;

    const audience = String(env.VERCEL_OIDC_AUDIENCE || "").trim();
    const subject = String(env.VERCEL_OIDC_SUBJECT || "").trim();
    if (!audience || !subject) return false;

    let jwks = jwksByIssuer.get(issuer);
    if (!jwks) {
      jwks = createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks`));
      jwksByIssuer.set(issuer, jwks);
    }

    await jwtVerify(token, jwks, { issuer, audience, subject });
    return true;
  } catch (error) {
    console.warn(JSON.stringify({ event: "vercel_oidc_rejected", error: readableError(error) }));
    return false;
  }
}

async function searchShopee(env, url) {
  const query = String(url.searchParams.get("q") || "").trim();
  if (query.length < 2) return json({ error: "Nhập ít nhất 2 ký tự để tìm sản phẩm." }, 400);

  const keyword = query.slice(0, 180);
  const fallbackUrl = `https://shopee.vn/search?keyword=${encodeURIComponent(keyword)}`;
  const warnings = [];
  const apiKey = String(env.BRAVE_SEARCH_API_KEY || env.BRAVE_API_KEY || "").trim();

  if (apiKey) {
    try {
      const products = await searchShopeeWithBrave(apiKey, keyword);
      if (products.length) return searchResponse(keyword, products, "brave", fallbackUrl, warnings);
      warnings.push("Brave Search không tìm thấy URL sản phẩm có thể nhận diện.");
    } catch (error) {
      warnings.push(`Brave: ${truncate(readableError(error), 160)}`);
      console.warn(JSON.stringify({ event: "brave_search_failed", error: readableError(error) }));
    }
  }

  try {
    const products = await searchShopeeWithDuckDuckGo(keyword);
    if (products.length) return searchResponse(keyword, products, "duckduckgo", fallbackUrl, warnings);
    warnings.push("DuckDuckGo chưa tìm thấy URL sản phẩm Shopee phù hợp.");
  } catch (error) {
    warnings.push(`DuckDuckGo: ${truncate(readableError(error), 160)}`);
    console.warn(JSON.stringify({ event: "duckduckgo_search_failed", error: readableError(error) }));
  }

  try {
    const products = await searchShopeeWithBingRss(keyword);
    if (products.length) return searchResponse(keyword, products, "bing-rss", fallbackUrl, warnings);
    warnings.push("Bing RSS chưa tìm thấy URL sản phẩm Shopee phù hợp.");
  } catch (error) {
    warnings.push(`Bing RSS: ${truncate(readableError(error), 160)}`);
    console.warn(JSON.stringify({ event: "bing_rss_search_failed", error: readableError(error) }));
  }

  if (env.BROWSER?.quickAction) {
    try {
      const products = await searchShopeeWithBrowser(env, keyword);
      if (products.length) return searchResponse(keyword, products, "browser-web", fallbackUrl, warnings);
      warnings.push("Browser Run chưa tìm được URL sản phẩm Shopee từ kết quả web.");
    } catch (error) {
      warnings.push(`Browser: ${truncate(readableError(error), 160)}`);
      console.warn(JSON.stringify({ event: "browser_search_failed", error: readableError(error) }));
    }
  }

  return json({
    query: keyword,
    products: [],
    count: 0,
    source: "fallback",
    fallbackUrl,
    warnings,
    message: "Chưa đọc được kết quả tự động."
  });
}

function searchResponse(query, products, source, fallbackUrl, warnings) {
  return json({ query, products, count: products.length, source, fallbackUrl, warnings });
}

async function searchShopeeWithBrave(apiKey, keyword) {
  const endpoint = new URL(BRAVE_SEARCH_ENDPOINT);
  endpoint.searchParams.set("q", `site:shopee.vn ${keyword}`);
  endpoint.searchParams.set("country", "VN");
  endpoint.searchParams.set("search_lang", "vi");
  endpoint.searchParams.set("ui_lang", "vi-VN");
  endpoint.searchParams.set("count", "20");
  endpoint.searchParams.set("safesearch", "moderate");
  endpoint.searchParams.set("spellcheck", "true");
  endpoint.searchParams.set("text_decorations", "false");
  endpoint.searchParams.set("result_filter", "web");

  const response = await fetch(endpoint, {
    headers: { Accept: "application/json", "X-Subscription-Token": apiKey },
    redirect: "follow"
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);

  const payload = await response.json().catch(() => null);
  const rows = Array.isArray(payload?.web?.results) ? payload.web.results : [];
  const products = [];
  const seen = new Set();

  for (const row of rows) {
    const resultUrl = normalizeShopeeResultUrl(row?.url);
    const product = productFromUrl(resultUrl, cleanText(row?.title), cleanText(row?.description), firstUrl(row?.thumbnail?.src, row?.thumbnail?.original));
    if (product) addUniqueProduct(products, seen, product);
    if (products.length >= 18) break;
  }
  return products;
}

async function searchShopeeWithDuckDuckGo(keyword) {
  const endpoint = new URL("https://html.duckduckgo.com/html/");
  endpoint.searchParams.set("q", `site:shopee.vn ${keyword}`);
  endpoint.searchParams.set("kl", "vn-vi");

  const response = await fetch(endpoint, {
    headers: {
      Accept: "text/html,application/xhtml+xml",
      "Accept-Language": "vi-VN,vi;q=0.9,en;q=0.5",
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/136 Safari/537.36"
    },
    redirect: "follow"
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const html = await response.text();
  return productsFromHtmlAnchors(html, endpoint.href);
}

async function searchShopeeWithBingRss(keyword) {
  const endpoint = new URL("https://www.bing.com/search");
  endpoint.searchParams.set("q", `site:shopee.vn ${keyword}`);
  endpoint.searchParams.set("format", "rss");
  endpoint.searchParams.set("setlang", "vi-VN");
  endpoint.searchParams.set("cc", "vn");

  const response = await fetch(endpoint, {
    headers: {
      Accept: "application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.5",
      "User-Agent": "Mozilla/5.0 (compatible; ShopeePriceWatch/1.0)"
    },
    redirect: "follow"
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);

  const xml = await response.text();
  const products = [];
  const seen = new Set();
  const itemRegex = /<item\b[^>]*>([\s\S]*?)<\/item>/gi;
  let match;

  while ((match = itemRegex.exec(xml)) !== null) {
    const item = match[1];
    const link = decodeHtml(extractXmlTag(item, "link"));
    const title = cleanText(decodeHtml(extractXmlTag(item, "title")));
    const description = cleanText(decodeHtml(extractXmlTag(item, "description")));
    const product = productFromUrl(normalizeShopeeResultUrl(link), title, description);
    if (product) addUniqueProduct(products, seen, product);
    if (products.length >= 18) break;
  }
  return products;
}

async function searchShopeeWithBrowser(env, keyword) {
  const target = new URL("https://www.bing.com/search");
  target.searchParams.set("q", `site:shopee.vn ${keyword}`);
  target.searchParams.set("setlang", "vi-VN");
  target.searchParams.set("cc", "vn");

  const response = await env.BROWSER.quickAction("json", {
    url: target.href,
    prompt: "Extract up to 18 organic web search results that point to an individual product page on shopee.vn. Return the exact result title and the real destination Shopee URL. Ignore shop homepages, category pages, ads, login pages and non-Shopee results. Never invent a URL.",
    response_format: {
      type: "json_schema",
      json_schema: {
        type: "object",
        properties: {
          products: {
            type: "array",
            items: {
              type: "object",
              properties: { name: { type: "string" }, link: { type: "string" } },
              required: ["name", "link"]
            }
          }
        },
        required: ["products"]
      }
    },
    gotoOptions: { waitUntil: "networkidle2" },
    rejectResourceTypes: ["media", "font"]
  });

  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const payload = await response.json().catch(() => null);
  const rows = Array.isArray(payload?.result?.products) ? payload.result.products : [];
  const products = [];
  const seen = new Set();

  for (const row of rows) {
    const product = productFromUrl(normalizeShopeeResultUrl(row?.link), cleanText(row?.name), "Kết quả web từ Shopee Việt Nam");
    if (product) addUniqueProduct(products, seen, product);
    if (products.length >= 18) break;
  }
  return products;
}

function productsFromHtmlAnchors(html, baseUrl) {
  const products = [];
  const seen = new Set();
  const anchorRegex = /<a\b([^>]*?)href\s*=\s*(["'])([\s\S]*?)\2([^>]*)>([\s\S]*?)<\/a>/gi;
  let match;

  while ((match = anchorRegex.exec(html)) !== null) {
    const href = decodeHtml(match[3]);
    const title = cleanText(decodeHtml(match[5]));
    const resultUrl = normalizeSearchResultUrl(href, baseUrl);
    const product = productFromUrl(resultUrl, title, "Kết quả web từ Shopee Việt Nam");
    if (product) addUniqueProduct(products, seen, product);
    if (products.length >= 18) break;
  }
  return products;
}

function normalizeSearchResultUrl(value, baseUrl) {
  if (!value) return null;
  try {
    const url = new URL(value, baseUrl);
    const direct = normalizeShopeeResultUrl(url.href);
    if (direct) return direct;

    for (const key of ["uddg", "rut", "url", "u", "target", "r"]) {
      const nested = url.searchParams.get(key);
      if (!nested) continue;
      const candidates = [nested];
      try { candidates.push(decodeURIComponent(nested)); } catch {}
      for (const candidate of candidates) {
        const normalized = normalizeShopeeResultUrl(candidate);
        if (normalized) return normalized;
      }
    }
  } catch {}
  return null;
}

function normalizeShopeeResultUrl(value) {
  if (!value) return null;
  try {
    const url = new URL(String(value), "https://shopee.vn/");
    const host = url.hostname.toLowerCase();
    if (host === "shopee.vn" || host.endsWith(".shopee.vn")) return url;

    for (const key of ["url", "u", "target", "r", "uddg"]) {
      const nested = url.searchParams.get(key);
      if (!nested) continue;
      try {
        const decoded = new URL(decodeURIComponent(nested));
        const nestedHost = decoded.hostname.toLowerCase();
        if (nestedHost === "shopee.vn" || nestedHost.endsWith(".shopee.vn")) return decoded;
      } catch {}
    }
  } catch {}
  return null;
}

function productFromUrl(resultUrl, name = "", description = "", imageUrl = null) {
  if (!resultUrl) return null;
  const ids = parseShopeeIds(resultUrl);
  if (!ids) return null;
  return {
    shopId: ids.shopId,
    itemId: ids.itemId,
    name: stripShopeeSuffix(name) || nameFromShopeeUrl(resultUrl) || `Shopee ${ids.shopId}.${ids.itemId}`,
    imageUrl: imageUrl || null,
    priceMin: null,
    priceMax: null,
    discount: null,
    rating: null,
    sold: null,
    shopLocation: description ? truncate(description, 110) : "Shopee Việt Nam",
    url: `https://shopee.vn/product/${ids.shopId}/${ids.itemId}`,
    sourceUrl: resultUrl.href
  };
}

function addUniqueProduct(products, seen, product) {
  const key = `${product.shopId}:${product.itemId}`;
  if (seen.has(key)) return false;
  seen.add(key);
  products.push(product);
  return true;
}

function parseShopeeIds(url) {
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

function extractXmlTag(xml, tag) {
  const match = String(xml || "").match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
  if (!match) return "";
  return match[1].replace(/^<!\[CDATA\[|\]\]>$/g, "");
}

function decodeHtml(value) {
  return String(value || "")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)));
}

function nameFromShopeeUrl(url) {
  try {
    const path = decodeURIComponent(url.pathname || "").replace(/^\/+|\/+$/g, "");
    const withoutIds = path.replace(/-?i\.\d+\.\d+.*$/i, "").replace(/\/product\/.*$/i, "");
    return cleanText(withoutIds.replace(/-/g, " "));
  } catch {
    return "";
  }
}

function cleanText(value) {
  return String(value || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function stripShopeeSuffix(value) {
  return String(value || "")
    .replace(/\s*[-|]\s*Shopee(?:\s+Việt Nam)?\s*$/i, "")
    .replace(/\s*\|\s*Shopee\s*$/i, "")
    .trim();
}

function truncate(value, max) {
  const text = String(value || "");
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

function firstUrl(...values) {
  for (const value of values) {
    if (!value) continue;
    try { return new URL(String(value)).href; } catch {}
  }
  return null;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

function readableError(error) {
  if (error instanceof Error) return error.message;
  return String(error || "Lỗi không xác định");
}
