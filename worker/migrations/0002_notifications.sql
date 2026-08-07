CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL DEFAULT 'price_drop',
  product_id TEXT,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  url TEXT,
  created_at TEXT NOT NULL,
  read_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_notifications_created_at ON notifications(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_unread ON notifications(read_at, created_at DESC);
