-- 0003_auth_tokens — one-time tokens for email verification + password reset.
-- expires_at is epoch MILLISECONDS (INTEGER) to avoid SQLite ISO/datetime('now')
-- string-comparison pitfalls.
PRAGMA defer_foreign_keys = TRUE;

CREATE TABLE IF NOT EXISTS auth_tokens (
  id          TEXT PRIMARY KEY,
  account_id  TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  purpose     TEXT NOT NULL,                 -- verify_email | password_reset
  token_hash  TEXT NOT NULL UNIQUE,          -- sha-256 hex of the opaque token
  expires_at  INTEGER NOT NULL,              -- epoch ms
  consumed_at TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_auth_tokens_account ON auth_tokens(account_id, purpose);
