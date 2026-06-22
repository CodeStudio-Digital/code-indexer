-- 0011_backups — online backups of CodeStudio METADATA (sessions, collections,
-- environment structure, memory, checkpoints) — NEVER source code (that's in git).
-- The gzipped bundle lives in R2 (ASSETS bucket); this table is the index + the
-- per-tier retention metadata. Entitlement-gated (`backup`). Forward-only.
CREATE TABLE backups (
  id              TEXT PRIMARY KEY,
  account_id      TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  r2_key          TEXT NOT NULL,            -- object in R2: backups/<account>/<id>.gz
  label           TEXT NOT NULL DEFAULT '',
  byte_size       INTEGER NOT NULL,
  content_sha256  TEXT NOT NULL,
  manifest_json   TEXT NOT NULL DEFAULT '{}', -- counts: { sessions, collections, environments, memory, ... }
  created_at_ms   INTEGER NOT NULL,
  expires_at_ms   INTEGER                    -- retention (per tier); NULL = keep
);
CREATE INDEX idx_backups_account ON backups(account_id, created_at_ms);
