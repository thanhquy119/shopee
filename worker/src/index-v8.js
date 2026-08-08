import { buildPushPayload } from "@block65/webcrypto-web-push";
import baseHandler from "./index-v7.js";

const RESET_BEFORE = "2026-08-08T05:51:00.000Z";
const RETENTION_MS = 2 * 24 * 60 * 60 * 1000;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/api/health" && request.method === "GET") {
      const response = await baseHandler.fetch(request, env, ctx);
      if (!response.ok) return response;
      const data = await response.json().catch(() => ({}));
      return jsonFrom(response, {
        ...data,
        notificationRetention: "2d",
        testNotificationHistory: false
      });
    }

    if (url.pathname === "/api/notifications" && request.method === "GET") {
      const auth = await authorizeThroughBase(request, env, ctx);
      if (!auth.ok) return auth;
      await cleanupNotifications(env);
      return baseHandler.fetch(request, env, ctx);
    }

    if (url.pathname === "/api/test-notification" && request.method === "POST") {
      const auth = await authorizeThroughBase(request, env, ctx);
      if (!auth.ok) return auth;

      const payload = {
        title: "S. — Thông báo hoạt động",
        body: "Web Push đã kết nối thành công.",
        url: env.ALLOWED_ORIGIN || "/",
        tag: `test-${Date.now()}`
      };

      ctx.waitUntil(sendPushToAll(env, payload));
      return jsonFrom(auth, { ok: true, historySaved: false });
    }

    return baseHandler.fetch(request, env, ctx);
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(cleanupNotifications(env));
    return baseHandler.scheduled(controller, env, ctx);
  }
};

async function authorizeThroughBase(request, env, ctx) {
  const probe = new Request(new URL("/api/health", request.url), {
    method: "GET",
    headers: { Authorization: request.headers.get("Authorization") || "" }
  });
  return baseHandler.fetch(probe, env, ctx);
}

async function cleanupNotifications(env) {
  const retentionCutoff = new Date(Date.now() - RETENTION_MS).toISOString();
  await env.DB.prepare(
    `DELETE FROM notifications
      WHERE type = 'test'
         OR created_at < ?
         OR created_at < ?`
  ).bind(RESET_BEFORE, retentionCutoff).run();
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
      console.error(JSON.stringify({
        event: "test_push_exception",
        error: error instanceof Error ? error.message : String(error)
      }));
    }
  }

  return sent;
}

function jsonFrom(sourceResponse, data, status = 200) {
  const headers = new Headers(sourceResponse.headers);
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  return new Response(JSON.stringify(data), { status, headers });
}
