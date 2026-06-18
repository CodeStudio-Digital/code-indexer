-- 0006_feedback — bug/idea/report intake. Raw IP/email are NEVER stored, only
-- salted hashes (forensics, never displayed). attachment_ids is a JSON array of
-- owned feedback_attachments. Admin triage columns (status) exist but the admin
-- surface is deferred (needs a role system).
PRAGMA defer_foreign_keys = TRUE;

CREATE TABLE IF NOT EXISTS feedback_tickets (
  id               TEXT PRIMARY KEY,
  public_id        TEXT NOT NULL UNIQUE,         -- short, non-enumerable (fb_…)
  kind             TEXT NOT NULL,                -- bug | idea | other
  status           TEXT NOT NULL DEFAULT 'open', -- open | triaged | resolved | wontfix | spam
  message          TEXT NOT NULL,                -- redacted, <= 4000
  submitter_kind   TEXT NOT NULL,                -- account | anonymous
  account_id       TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  email_hash       TEXT,                         -- anonymous forensics, never displayed
  ip_hash          TEXT,                         -- salted, never displayed
  app_version      TEXT,
  os               TEXT,
  session_share_id TEXT,                         -- points at a signed Phase-4 share (repro)
  attachment_ids   TEXT NOT NULL DEFAULT '[]',   -- JSON array of attachment ids
  created_at_ms    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_feedback_account ON feedback_tickets(account_id, created_at_ms);

CREATE TABLE IF NOT EXISTS feedback_attachments (
  id            TEXT PRIMARY KEY,
  account_id    TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  r2_key        TEXT NOT NULL UNIQUE,            -- server-generated key in R2
  content_type  TEXT NOT NULL,                   -- sniffed
  kind          TEXT NOT NULL,                   -- image | text | diagnostic-json
  byte_size     INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_feedback_att_account ON feedback_attachments(account_id);
