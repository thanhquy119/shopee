CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  canonical_url TEXT NOT NULL,
  shop_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  name TEXT,
  image_url TEXT,
  baseline_price INTEGER NOT NULL,
  current_price INTEGER NOT NULL,
  lowest_price INTEGER NOT NULL,
  last_notified_price INTEGER,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  checked_at TEXT NOT NULL,
  check_error TEXT
);

CREATE INDEX IF NOT EXISTS idx_products_active ON products(active);

CREATE TABLE IF NOT EXISTS price_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id TEXT NOT NULL,
  price INTEGER NOT NULL,
  checked_at TEXT NOT NULL,
  FOREIGN KEY(product_id) REFERENCES products(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_price_history_product_time ON price_history(product_id, checked_at DESC);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint TEXT PRIMARY KEY,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);
