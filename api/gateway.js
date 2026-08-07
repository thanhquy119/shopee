export default async function handler(req, res) {
  const workerUrl = String(process.env.SHOPEE_WORKER_URL || "").replace(/\/$/, "");
  const appToken = String(process.env.SHOPEE_APP_TOKEN || "");

  if (!workerUrl || !appToken) {
    return res.status(503).json({
      error: "Hệ thống chưa được cấu hình SHOPEE_WORKER_URL/SHOPEE_APP_TOKEN trên Vercel."
    });
  }

  const rawPath = Array.isArray(req.query.path) ? req.query.path[0] : req.query.path;
  let path;
  try {
    path = decodeURIComponent(String(rawPath || ""));
  } catch {
    path = String(rawPath || "");
  }

  if (!path.startsWith("/api/")) {
    return res.status(400).json({ error: "API path không hợp lệ." });
  }

  const allowedMethods = new Set(["GET", "POST", "DELETE"]);
  if (!allowedMethods.has(req.method)) {
    res.setHeader("Allow", [...allowedMethods].join(", "));
    return res.status(405).json({ error: "Method không được hỗ trợ." });
  }

  try {
    const target = `${workerUrl}${path}`;
    const headers = {
      Authorization: `Bearer ${appToken}`,
      Accept: "application/json"
    };

    let body;
    if (req.method !== "GET" && req.body !== undefined) {
      headers["Content-Type"] = "application/json";
      body = typeof req.body === "string" ? req.body : JSON.stringify(req.body);
    }

    const upstream = await fetch(target, {
      method: req.method,
      headers,
      body,
      redirect: "follow"
    });

    const text = await upstream.text();
    res.status(upstream.status);
    res.setHeader("Content-Type", upstream.headers.get("content-type") || "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    return res.send(text);
  } catch (error) {
    console.error("gateway error", error);
    return res.status(502).json({ error: "Không kết nối được Cloudflare Worker." });
  }
}
