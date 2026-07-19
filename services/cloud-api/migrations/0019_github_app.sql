-- 0019_github_app — optional MegaBrain GitHub App identity.
--
-- Installation access tokens and user OAuth tokens are NEVER persisted. The
-- durable state is limited to the account↔installation relationship, short-lived
-- one-use operation grants (stored as SHA-256 only), and coarse usage events.

PRAGMA defer_foreign_keys = TRUE;

CREATE TABLE IF NOT EXISTS github_app_installations (
  account_id           TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  installation_id      INTEGER NOT NULL,
  github_account_id    INTEGER NOT NULL,
  github_account_login TEXT NOT NULL,
  github_account_type  TEXT NOT NULL,
  repository_selection TEXT NOT NULL CHECK (repository_selection IN ('all', 'selected')),
  permissions_json     TEXT NOT NULL DEFAULT '{}',
  app_slug             TEXT NOT NULL,
  manage_url           TEXT,
  suspended_at         TEXT,
  linked_at            TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at           TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (account_id, installation_id)
);
CREATE INDEX IF NOT EXISTS idx_github_installation_id
  ON github_app_installations(installation_id);

CREATE TABLE IF NOT EXISTS github_app_operation_grants (
  grant_hash      TEXT PRIMARY KEY,
  account_id      TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  installation_id INTEGER NOT NULL,
  repository_owner TEXT NOT NULL,
  repository_name  TEXT NOT NULL,
  operation       TEXT NOT NULL CHECK (operation IN ('push', 'fetch')),
  expires_at      INTEGER NOT NULL,
  consumed_at     TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_github_grant_expires
  ON github_app_operation_grants(expires_at, consumed_at);

CREATE TABLE IF NOT EXISTS github_app_usage_events (
  id              TEXT PRIMARY KEY,
  account_id      TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  installation_id INTEGER,
  operation       TEXT NOT NULL,
  outcome         TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_github_usage_created
  ON github_app_usage_events(created_at);
CREATE INDEX IF NOT EXISTS idx_github_usage_account
  ON github_app_usage_events(account_id, created_at);
