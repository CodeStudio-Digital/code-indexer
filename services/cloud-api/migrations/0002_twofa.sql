-- 0002_twofa — TOTP 2FA + one-time recovery codes. Forward-only, idempotent.
PRAGMA defer_foreign_keys = TRUE;

CREATE TABLE IF NOT EXISTS totp_secrets (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  secret     TEXT NOT NULL,                       -- base32
  enabled    INTEGER NOT NULL DEFAULT 0,          -- 0 = pending, 1 = confirmed
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS recovery_codes (
  id         TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  code_hash  TEXT NOT NULL,                        -- sha-256 hex of the normalized code
  used_at    TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_recovery_account ON recovery_codes(account_id, used_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_recovery_hash ON recovery_codes(account_id, code_hash);
