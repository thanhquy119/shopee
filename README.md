# S. — Shopee Price Watch

PWA cá nhân theo dõi giá sản phẩm Shopee Việt Nam. Frontend là static site để Vercel chỉ phục vụ HTML/CSS/JS; việc kiểm tra giá mỗi giờ chạy ở Cloudflare Worker + D1.

## Tính năng

- Dán link Shopee, lấy giá hiện tại làm mốc.
- Cloudflare Cron kiểm tra lại mỗi giờ (`0 * * * *`).
- Lưu giá hiện tại, giá thấp nhất và lịch sử giá vào D1.
- Web Push khi giá thấp hơn mốc ban đầu; chỉ báo lại khi có mức giá thấp hơn lần đã thông báo trước.
- PWA cài được, giao diện trắng/đen, JetBrains Mono, logo `S.`.
- Vercel không dùng Function/Cron cho app này.

## Kiến trúc

```text
PWA static (Vercel)
        |
        | HTTPS + Bearer APP_TOKEN
        v
Cloudflare Worker ----> Shopee public product endpoints
        |
        +---- D1 (products / price_history / push_subscriptions)
        |
        +---- Cron mỗi giờ
        |
        +---- Web Push (VAPID)
```

## 1. Tạo D1

```bash
cd worker
npm install
npx wrangler login
npx wrangler d1 create shopee-price-watcher
```

Copy `database_id` mà Wrangler trả về vào `worker/wrangler.jsonc`.

## 2. Tạo APP_TOKEN + VAPID keys

```bash
node scripts/generate-secrets.mjs
```

Sau đó lưu secret vào Cloudflare (không commit các giá trị này):

```bash
npx wrangler secret put APP_TOKEN
npx wrangler secret put VAPID_PUBLIC_KEY
npx wrangler secret put VAPID_PRIVATE_KEY
npx wrangler secret put VAPID_SUBJECT
```

`VAPID_SUBJECT` nên là `mailto:email-cua-ban@example.com` hoặc URL HTTPS của app.

## 3. Chạy migration và deploy Worker

```bash
npx wrangler d1 migrations apply shopee-price-watcher --remote
npx wrangler deploy
```

Sau deploy sẽ có URL dạng:

```text
https://shopee-price-watcher.<subdomain>.workers.dev
```

## 4. Cấu hình CORS

Trong `worker/wrangler.jsonc`, thay:

```text
https://REPLACE_WITH_VERCEL_DOMAIN
```

bằng domain production của frontend, rồi deploy Worker lại.

## 5. Deploy frontend lên Vercel

Import repo này vào Vercel. Repo là static site; không cần Build Command, không dùng Vercel Functions.

Sau khi mở app:

1. `Cài đặt`.
2. Nhập URL Worker.
3. Nhập cùng `APP_TOKEN` đã lưu ở Cloudflare.
4. `Lưu kết nối`.
5. `Bật thông báo`.
6. Dán link Shopee để theo dõi.

Worker URL và API key được lưu ở `localStorage` của thiết bị, không nằm trong source code.

## GitHub Actions (tuỳ chọn)

Workflow `.github/workflows/cloudflare-worker.yml` cho phép deploy Worker thủ công từ tab Actions sau khi cấu hình xong D1. Cần GitHub repository secrets:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

Các runtime secrets (`APP_TOKEN`, VAPID keys) vẫn quản lý bằng `wrangler secret put` trên Cloudflare.

## Shopee anti-bot

Provider hiện thử lần lượt `/api/v4/pdp/get_pc` và `/api/v4/item/get`, có parser tách riêng trong `worker/src/index.js`. Shopee có thể chặn request từ IP datacenter hoặc thay đổi endpoint bất kỳ lúc nào. Nếu public request bắt đầu bị chặn, có thể lưu cookie phiên của **chính tài khoản của bạn** bằng `npx wrangler secret put SHOPEE_COOKIE`; không commit cookie vào repo.

Không có code CAPTCHA bypass hay cơ chế né anti-bot. Nếu Shopee thay đổi cơ chế mạnh hơn, chỉ cần thay provider thay vì viết lại PWA/database/notification.
