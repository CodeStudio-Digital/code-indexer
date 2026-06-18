-- 0007_hardening — append-only security audit log. account_id is plain TEXT
-- (NO foreign key) so an audit row SURVIVES account erasure (a compliance
-- tombstone). ts_ms is epoch ms. meta_json never contains secrets (the writer
-- redacts). Triggers make the table immutable: no UPDATE, no DELETE — only INSERT.
PRAGMA defer_foreign_keys = TRUE;

CREATE TABLE IF NOT EXISTS audit_log (
  id          TEXT PRIMARY KEY,
  ts_ms       INTEGER NOT NULL,
  event       TEXT NOT NULL,              -- signup | login_ok | login_fail | password_reset | mfa_enabled | …
  account_id  TEXT,                       -- principal (nullable for anon); NO FK by design
  ip_hash     TEXT,                       -- salted; never the raw IP
  status      INTEGER NOT NULL,           -- HTTP-ish outcome
  meta_json   TEXT NOT NULL DEFAULT '{}'  -- redacted scalars only
);

CREATE INDEX IF NOT EXISTS idx_audit_account ON audit_log(account_id, ts_ms);
CREATE INDEX IF NOT EXISTS idx_audit_event   ON audit_log(event, ts_ms);

CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit_log
  BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit_log
  BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
