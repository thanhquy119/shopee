import { createRemoteJWKSet, decodeJwt, jwtVerify } from "jose";
import baseHandler from "./index-v2.js";

const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8" };
const BRAVE_SEARCH_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";
const JINA_READER_PREFIX = "https://r.jina.ai/";
const GLOBAL_VERCEL_ISSUER = "https://oidc.vercel.com";
const jwksByIssuer = new Map();

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/api/config" && request.method === "GET") {
      return baseHandler.fetch(request, env, ctx);
    }

    const auth = await authorizeRequest(request, env);
    if (!auth) {
      return json({ error: "Không xác thực được yêu cầu từ ứng dụng." }, 401);
    }

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
      if (products.length) {
        return json({ query: keyword, products, count: products.length, source: "brave", fallbackUrl });
      }
      warnings.push("Brave Search không tìm thấy URL sản phẩm có thể nhận diện.");
    } catch (error) {
      warnings.push(`Brave: ${truncate(readableError(error), 180)}`);
      console.warn(JSON.stringify({ event: "brave_search_failed", error: readableError(error) }));
    }
  }

  try {
    const products = await searchShopeeWithJina(keyword);
    if (products.length) {
      return json({ query: keyword, products, count: products.length, source: "jina-reader", fallbackUrl, warnings });
    }
    warnings.push("Jina Reader chưa tìm thấy URL sản phẩm Shopee phù hợp.");
  } catch (error) {
    warnings.push(`Jina: ${truncate(readableError(error), 180)}`);
    console.warn(JSON.stringify({ event: "jina_search_failed", error: readableError(error) }));
  }

  if (env.BROWSER?.quickAction) {
    try {
      const products = await searchShopeeWithBrowser(env, keyword);
      if (products.length) {
        return json({ query: keyword, products, count: products.length, source: "browser-web", fallbackUrl, warnings });
      }
      warnings.push("Browser Run chưa tìm được URL sản phẩm Shopee từ kết quả web.");
    } catch (error) {
      warnings.push(`Browser: ${truncate(readableError(error), 180)}`);
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
    method: "GET",
    headers: { "Accept": "application/json", "X-Subscription-Token": apiKey },
    redirect: "follow"
  });
  if (!response.ok) throw new Error(`Brave Search HTTP ${response.status}`);

  const payload = await response.json().catch(() => null);
  if (!payload) throw new Error("Brave Search không trả về dữ liệu hợp lệ.");

  const rows = Array.isArray(payload?.web?.results) ? payload.web.results : [];
  const seen = new Set();
  const products = [];
  for (const row of rows) {
    const product = parseBraveShopeeResult(row);
    if (!product) continue;
    addUniqueProduct(products, seen, product);
    if (products.length >= 18) break;
  }
  return products;
}

async function searchShopeeWithJina(keyword) {
  const target = new URL("https://www.bing.com/search");
  target.searchParams.set("q", `site:shopee.vn ${keyword}`);
  target.searchParams.set("setlang", "vi-VN");
  target.searchParams.set("cc", "vn");

  const response = await fetch(`${JINA_READER_PREFIX}${target.href}`, {
    method: "GET",
    headers: {
      "Accept": "text/markdown, text/plain;q=0.9, */*;q=0.8",
      "X-Return-Format": "markdown"
    },
    redirect: "follow"
  });
  if (!response.ok) throw new Error(`Jina Reader HTTP ${response.status}`);

  const markdown = await response.text();
  if (!markdown.trim()) return [];

  const products = [];
  const seen = new Set();
  const markdownLink = /\[([^\]]{1,500})\]\((https?:\/\/[^)\s]+)\)/g;
  let match;

  while ((match = markdownLink.exec(markdown)) !== null) {
    const resultUrl = normalizeShopeeResultUrl(decodeMarkupUrl(match[2]));
    if (!resultUrl) continue;
    const ids = parseShopeeIds(resultUrl);
    if (!ids) continue;

    addUniqueProduct(products, seen, {
      shopId: ids.shopId,
      itemId: ids.itemId,
      name: cleanSearchTitle(match[1]) || nameFromShopeeUrl(resultUrl) || `Shopee ${ids.shopId}.${ids.itemId}`,
      imageUrl: null,
      priceMin: null,
      priceMax: null,
      discount: null,
      rating: null,
      sold: null,
      shopLocation: "Kết quả web từ Shopee Việt Nam",
      url: `https://shopee.vn/product/${ids.shopId}/${ids.itemId}`,
      sourceUrl: resultUrl.href
    });
    if (products.length >= 18) return products;
  }

  const rawUrlRegex = /https?:\/\/(?:www\.)?shopee\.vn\/[A-Za-z0-9%._~:/?#\[\]@!$&'()*+,;=\-]+/gi;
  while ((match = rawUrlRegex.exec(markdown)) !== null) {
    const resultUrl = normalizeShopeeResultUrl(decodeMarkupUrl(match[0]));
    if (!resultUrl) continue;
    const ids = parseShopeeIds(resultUrl);
    if (!ids) continue;

    addUniqueProduct(products, seen, {
      shopId: ids.shopId,
      itemId: ids.itemId,
      name: nameFromShopeeUrl(resultUrl) || `Shopee ${ids.shopId}.${ids.itemId}`,
      imageUrl: null,
      priceMin: null,
      priceMax: null,
      discount: null,
      rating: null,
      sold: null,
      shopLocation: "Kết quả web từ Shopee Việt Nam",
      url: `https://shopee.vn/product/${ids.shopId}/${ids.itemId}`,
      sourceUrl: resultUrl.href
    });
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
    prompt: "Extract up to 18 organic web search results that point to an individual product page on shopee.vn. Return the exact result title and the real destination Shopee URL, not a Bing redirect URL. Ignore shop homepages, category/list pages, ads, login pages and non-Shopee results. Never invent a URL.",
    response_format: {
      type: "json_schema",
      json_schema: {
        type: "object",
        properties: {
          products: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                link: { type: "string" }
              },
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

  if (!response.ok) throw new Error(`Browser Run web search HTTP ${response.status}`);
  const payload = await response.json().catch(() => null);
  const rows = Array.isArray(payload?.result?.products) ? payload.result.products : [];
  const seen = new Set();
  const products = [];

  for (const row of rows) {
    const resultUrl = normalizeShopeeResultUrl(row?.link);
    if (!resultUrl) continue;
    const ids = parseShopeeIds(resultUrl);
    if (!ids) continue;

    addUniqueProduct(products, seen, {
      shopId: ids.shopId,
      itemId: ids.itemId,
      name: cleanText(row?.name) || nameFromShopeeUrl(resultUrl) || `Shopee ${ids.shopId}.${ids.itemId}`,
      imageUrl: null,
      priceMin: null,
      priceMax: null,
      discount: null,
      rating: null,
      sold: null,
      shopLocation: "Kết quả web từ Shopee Việt Nam",
      url: `https://shopee.vn/product/${ids.shopId}/${ids.itemId}`,
      sourceUrl: resultUrl.href
    });
    if (products.length >= 18) break;
  }

  return products;
}

function addUniqueProduct(products, seen, product) {
  const key = `${product.shopId}:${product.itemId}`;
  if (seen.has(key)) return false;
  seen.add(key);
  products.push(product);
  return true;
}

function normalizeShopeeResultUrl(value) {
  if (!value) return null;
  try {
    const url = new URL(String(value), "https://shopee.vn/");
    const host = url.hostname.toLowerCase();
    if (host === "shopee.vn" || host.endsWith(".shopee.vn")) return url;

    for (const key of ["url", "u", "target", "r"]) {
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

function parseBraveShopeeResult(row) {
  if (!row || typeof row !== "object") return null;
  const resultUrl = normalizeShopeeResultUrl(row.url);
  if (!resultUrl) return null;
  const ids = parseShopeeIds(resultUrl);
  if (!ids) return null;

  const title = cleanText(row.title) || `Shopee ${ids.shopId}.${ids.itemId}`;
  const description = cleanText(row.description);
  return {
    shopId: ids.shopId,
    itemId: ids.itemId,
    name: stripShopeeSuffix(title),
    imageUrl: firstUrl(row?.thumbnail?.src, row?.thumbnail?.original, row?.profile?.img, row?.meta_url?.favicon),
    priceMin: null,
    priceMax: null,
    discount: null,
    rating: null,
    sold: null,
    shopLocation: description ? truncate(description, 110) : "Kết quả từ Shopee Việt Nam",
    url: `https://shopee.vn/product/${ids.shopId}/${ids.itemId}`,
    sourceUrl: resultUrl.href
  };
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

function decodeMarkupUrl(value) {
  return String(value || "")
    .replace(/&amp;/gi, "&")
    .replace(/\\([()])/g, "$1")
    .replace(/[.,;]+$/, "");
}

function cleanSearchTitle(value) {
  return cleanText(value)
    .replace(/^Image\s*\d*\s*:?\s*/i, "")
    .replace(/^\d+\.\s*/, "")
    .trim();
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
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function stripShopeeSuffix(value) {
  return value
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
    try {
      return new URL(String(value)).href;
    } catch {}
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
