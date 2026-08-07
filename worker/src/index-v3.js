import baseHandler from "./index-v2.js";

const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8" };

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/api/search" && request.method === "GET") {
      if (!env.APP_TOKEN || request.headers.get("Authorization") !== `Bearer ${env.APP_TOKEN}`) {
        return json({ error: "API key không đúng." }, 401);
      }

      try {
        return await searchShopee(request, env, url);
      } catch (error) {
        console.error("search error", error);
        return json({
          error: readableError(error),
          code: "SHOPEE_SEARCH_FAILED"
        }, 502);
      }
    }

    return baseHandler.fetch(request, env, ctx);
  },

  async scheduled(controller, env, ctx) {
    return baseHandler.scheduled(controller, env, ctx);
  }
};

async function searchShopee(request, env, url) {
  const query = String(url.searchParams.get("q") || "").trim();
  if (query.length < 2) {
    return json({ error: "Nhập ít nhất 2 ký tự để tìm sản phẩm." }, 400);
  }

  const keyword = query.slice(0, 120);
  const globalSearchSession = `gs-${crypto.randomUUID()}`;
  const searchSession = `ss-${crypto.randomUUID()}`;
  const viewSession = crypto.randomUUID();
  const extraParams = JSON.stringify({
    global_search_session_id: globalSearchSession,
    search_session_id: searchSession
  });

  const endpoint = new URL("https://shopee.vn/api/v4/search/search_items");
  endpoint.searchParams.set("by", "relevancy");
  endpoint.searchParams.set("keyword", keyword);
  endpoint.searchParams.set("limit", "18");
  endpoint.searchParams.set("newest", "0");
  endpoint.searchParams.set("order", "desc");
  endpoint.searchParams.set("page_type", "search");
  endpoint.searchParams.set("scenario", "PAGE_GLOBAL_SEARCH");
  endpoint.searchParams.set("source", "SRP");
  endpoint.searchParams.set("version", "2");
  endpoint.searchParams.set("extra_params", extraParams);
  endpoint.searchParams.set("view_session_id", viewSession);

  const referer = `https://shopee.vn/search?keyword=${encodeURIComponent(keyword)}`;
  const headers = {
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "vi-VN,vi;q=0.9,en-US;q=0.7,en;q=0.6",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
    "Referer": referer,
    "x-api-source": "pc",
    "x-shopee-language": "vi",
    "af-ac-enc-dat": "1"
  };
  if (env.SHOPEE_COOKIE) headers.Cookie = env.SHOPEE_COOKIE;

  const response = await fetch(endpoint, { headers, redirect: "follow" });
  if (!response.ok) {
    throw new Error(`Shopee từ chối tìm kiếm (HTTP ${response.status}).`);
  }

  const payload = await response.json().catch(() => null);
  if (!payload) throw new Error("Shopee không trả về dữ liệu tìm kiếm hợp lệ.");
  if (payload.error || payload.error_msg) {
    throw new Error(payload.error_msg || `Shopee error ${payload.error}`);
  }

  const rows = payload.items || payload.data?.items || [];
  if (!Array.isArray(rows)) {
    throw new Error("Định dạng kết quả tìm kiếm của Shopee đã thay đổi.");
  }

  const products = rows
    .map(parseSearchItem)
    .filter(Boolean)
    .slice(0, 18);

  return json({
    query: keyword,
    products,
    count: products.length
  });
}

function parseSearchItem(row) {
  const item = row?.item_basic || row?.item || row;
  if (!item || typeof item !== "object") return null;

  const shopId = item.shopid ?? item.shop_id ?? row?.shopid ?? row?.shop_id;
  const itemId = item.itemid ?? item.item_id ?? row?.itemid ?? row?.item_id;
  if (!shopId || !itemId) return null;

  const rawMin = firstNumber(item.price_min, item.price, row?.price_min, row?.price);
  const rawMax = firstNumber(item.price_max, item.price, row?.price_max, row?.price);
  const priceMin = normalizeShopeePrice(rawMin);
  const priceMax = normalizeShopeePrice(rawMax);

  const imageValue = item.image || item.image_hash || item.images?.[0] || row?.image;
  const imageUrl = imageValue
    ? (String(imageValue).startsWith("http")
      ? String(imageValue)
      : `https://down-vn.img.susercontent.com/file/${imageValue}`)
    : null;

  const name = String(item.name || item.title || row?.name || `Shopee ${shopId}.${itemId}`);

  return {
    shopId: String(shopId),
    itemId: String(itemId),
    name,
    imageUrl,
    priceMin,
    priceMax,
    discount: item.discount || row?.discount || null,
    rating: Number(item.item_rating?.rating_star || item.rating_star || 0) || null,
    sold: Number(item.historical_sold || item.sold || 0) || null,
    shopLocation: item.shop_location || item.shop_location_name || null,
    url: `https://shopee.vn/product/${shopId}/${itemId}`
  };
}

function firstNumber(...values) {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number) && number > 0) return number;
  }
  return null;
}

function normalizeShopeePrice(raw) {
  if (!Number.isFinite(Number(raw)) || Number(raw) <= 0) return null;
  return Math.round(Number(raw) / 100000);
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
