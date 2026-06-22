-- 0016_oauth — browser OAuth (P7-B). Two tables:
--   oauth_identities — links a provider subject (Google/GitHub/Microsoft) to an
--     account. (provider, provider_user_id) is the IMMUTABLE join key (UNIQUE);
--     never keyed on email (anti-takeover). FK cascades on account delete.
--   oauth_handoffs — one-time codes that hand a freshly-issued session from the
--     worker callback to the desktop (loopback) or web portal. code_hash only
--     (SHA-256 of the opaque code); payload is the JSON {account, session}; claim
--     is atomic (UPDATE ... WHERE consumed_at IS NULL) and TTL-bounded.
PRAGMA defer_foreign_keys = TRUE;

CREATE TABLE IF NOT EXISTS oauth_identities (
  id               TEXT PRIMARY KEY,
  provider         TEXT NOT NULL,
  provider_user_id TEXT NOT NULL,
  account_id       TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  email_at_link    TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (provider, provider_user_id)
);
CREATE INDEX IF NOT EXISTS idx_oauth_identity_account ON oauth_identities(account_id);

CREATE TABLE IF NOT EXISTS oauth_handoffs (
  code_hash   TEXT PRIMARY KEY,
  payload     TEXT NOT NULL,
  expires_at  INTEGER NOT NULL,          -- epoch ms
  consumed_at TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_oauth_handoff_expires ON oauth_handoffs(expires_at);
