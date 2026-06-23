-- 0001_init — Identity baseline (Phase 0). Forward-only, idempotent (IF NOT
-- EXISTS) so a later `wrangler d1 migrations apply` re-applies safely after this
-- file was first applied out-of-band via the D1 API. D1/SQLite dialect; times
-- are TEXT ISO-8601 via datetime('now'). Later phases add their own NNNN_*.sql.

PRAGMA defer_foreign_keys = TRUE;

-- Accounts (the identity root). Password is an Argon2id PHC string (Phase 1);
-- email_canonical holds the normalized form used for the uniqueness constraint.
CREATE TABLE IF NOT EXISTS accounts (
  id                TEXT PRIMARY KEY,
  email             TEXT NOT NULL,
  email_canonical   TEXT NOT NULL UNIQUE,
  password_hash     TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'active',   -- active | locked | deleted
  email_verified_at TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

-- A login session (a device/browser). Refresh tokens hang off a session.
CREATE TABLE IF NOT EXISTS sessions (
  id           TEXT PRIMARY KEY,
  account_id   TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_agent   TEXT,
  ip_hash      TEXT,                                  -- hashed, never the raw IP
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  revoked_at   TEXT
);

-- Opaque refresh tokens (only the SHA-256 hash is stored). One-shot rotation:
-- `consumed_at` is set when rotated; reuse of a consumed token => revoke family.
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id          TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  account_id  TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL UNIQUE,
  family_id   TEXT NOT NULL,
  prev_id     TEXT,
  expires_at  TEXT NOT NULL,
  consumed_at TEXT,
  revoked_at  TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_accounts_status      ON accounts(status);
CREATE INDEX IF NOT EXISTS idx_sessions_account     ON sessions(account_id, revoked_at);
CREATE INDEX IF NOT EXISTS idx_refresh_family       ON refresh_tokens(family_id);
CREATE INDEX IF NOT EXISTS idx_refresh_session      ON refresh_tokens(session_id);
CREATE INDEX IF NOT EXISTS idx_refresh_expires      ON refresh_tokens(expires_at);
