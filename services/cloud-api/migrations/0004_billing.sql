-- 0004_billing — subscription projection + webhook idempotency.
-- `subscriptions` is one row per account (the entitlement source); Stripe is the
-- source of truth and webhooks project into it. `trial_used` is a one-shot latch
-- so the 14-day trial can never be granted twice. period_end_ms is epoch MS
-- (INTEGER) to dodge SQLite ISO/datetime('now') string-comparison pitfalls.
PRAGMA defer_foreign_keys = TRUE;

CREATE TABLE IF NOT EXISTS subscriptions (
  account_id         TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  plan               TEXT NOT NULL DEFAULT 'free',     -- free | pro
  status             TEXT NOT NULL DEFAULT 'none',      -- none | trialing | active | past_due | canceled
  period_end_ms      INTEGER,                           -- epoch ms; null when not time-bounded
  trial_used         INTEGER NOT NULL DEFAULT 0,        -- 0/1 — one-shot trial latch
  stripe_customer_id TEXT,                              -- Stripe 'cus_…'; null until first checkout
  updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_customer ON subscriptions(stripe_customer_id);

-- Webhook idempotency: Stripe re-delivers events, so each event id is applied once.
CREATE TABLE IF NOT EXISTS billing_webhook_events (
  event_id    TEXT PRIMARY KEY,
  received_at TEXT NOT NULL DEFAULT (datetime('now'))
);
