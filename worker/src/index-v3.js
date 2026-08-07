import { createRemoteJWKSet, decodeJwt, jwtVerify } from "jose";
import baseHandler from "./index-v2.js";

const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8" };
const BRAVE_SEARCH_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";
const GLOBAL_VERCEL_ISSUER = "https://oidc.vercel.com";
const jwksByIssuer = new Map();

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // /api/config intentionally stays public so the PWA can read the VAPID public key.
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
        time: new Date().toISOString()
      });
    }

    if (url.pathname === "/api/search" && request.method === "GET") {
      try {
        return await searchShopeeWithBrave(env, url);
      } catch (error) {
        console.error("search error", error);
        return json({
          error: readableError(error),
          code: "PRODUCT_SEARCH_FAILED"
        }, 502);
      }
    }

    // index-v2 still understands the legacy APP_TOKEN check. For a verified OIDC
    // request, give it a request-scoped token so no shared long-lived secret is needed.
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

  // Keep the old secret as a temporary fallback so current production does not break
  // while Vercel OIDC is being rolled out.
  if (env.APP_TOKEN && token === String(env.APP_TOKEN)) {
    return { mode: "legacy", token };
  }

  if (await verifyVercelOidc(token, env)) {
    return { mode: "oidc", token };
  }

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

    await jwtVerify(token, jwks, {
      issuer,
      audience,
      subject
    });
    return true;
  } catch (error) {
    console.warn(JSON.stringify({
      event: "vercel_oidc_rejected",
      error: readableError(error)
    }));
    return false;
  }
}

async function searchShopeeWithBrave(env, url) {
  const query = String(url.searchParams.get("q") || "").trim();
  if (query.length < 2) {
    return json({ error: "Nhập ít nhất 2 ký tự để tìm sản phẩm." }, 400);
  }

  const apiKey = String(env.BRAVE_SEARCH_API_KEY || env.BRAVE_API_KEY || "").trim();
  if (!apiKey) {
    return json({
      error: "Hệ thống chưa có BRAVE_SEARCH_API_KEY trên Cloudflare Worker.",
      code: "BRAVE_KEY_MISSING"
    }, 503);
  }

  const keyword = query.slice(0, 180);
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
    headers: {
      "Accept": "application/json",
      "X-Subscription-Token": apiKey
    },
    redirect: "follow"
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    const detail = body ? `: ${body.slice(0, 220)}` : "";
    throw new Error(`Brave Search từ chối yêu cầu (HTTP ${response.status})${detail}`);
  }

  const payload = await response.json().catch(() => null);
  if (!payload) throw new Error("Brave Search không trả về dữ liệu hợp lệ.");

  const rows = Array.isArray(payload?.web?.results) ? payload.web.results : [];
  const seen = new Set();
  const products = [];

  for (const row of rows) {
    const product = parseBraveShopeeResult(row);
    if (!product) continue;
    const key = `${product.shopId}:${product.itemId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    products.push(product);
    if (products.length >= 18) break;
  }

  return json({
    query: keyword,
    products,
    count: products.length,
    source: "brave"
  });
}

function parseBraveShopeeResult(row) {
  if (!row || typeof row !== "object") return null;

  let resultUrl;
  try {
    resultUrl = new URL(String(row.url || ""));
  } catch {
    return null;
  }

  const host = resultUrl.hostname.toLowerCase();
  if (!(host === "shopee.vn" || host.endsWith(".shopee.vn"))) return null;

  const ids = parseShopeeIds(resultUrl);
  if (!ids) return null;

  const canonicalUrl = `https://shopee.vn/product/${ids.shopId}/${ids.itemId}`;
  const title = cleanText(row.title) || `Shopee ${ids.shopId}.${ids.itemId}`;
  const description = cleanText(row.description);
  const imageUrl = firstUrl(
    row?.thumbnail?.src,
    row?.thumbnail?.original,
    row?.profile?.img,
    row?.meta_url?.favicon
  );

  return {
    shopId: ids.shopId,
    itemId: ids.itemId,
    name: stripShopeeSuffix(title),
    imageUrl,
    priceMin: null,
    priceMax: null,
    discount: null,
    rating: null,
    sold: null,
    shopLocation: description ? truncate(description, 110) : "Kết quả từ Shopee Việt Nam",
    url: canonicalUrl,
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

  const shopId = url.searchParams.get("shopid") || url.searchParams.get("shop_id");
  const itemId = url.searchParams.get("itemid") || url.searchParams.get("item_id");
  if (shopId && itemId) return { shopId, itemId };

  return null;
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
  return new Response(JSON.stringify(data), {
    status,
    headers: JSON_HEADERS
  });
}

function readableError(error) {
  if (error instanceof Error) return error.message;
  return String(error || "Lỗi không xác định");
}
