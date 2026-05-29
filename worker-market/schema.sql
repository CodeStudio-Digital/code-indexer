-- Hosted plugin Market catalog (D1).

CREATE TABLE IF NOT EXISTS plugins (
  name TEXT PRIMARY KEY,
  display_name TEXT,
  description TEXT,
  author TEXT,
  category TEXT,
  brand_color TEXT,
  latest_version TEXT NOT NULL,
  downloads INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS plugin_versions (
  name TEXT NOT NULL,
  version TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  signature TEXT NOT NULL,
  published_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (name, version)
);

CREATE TABLE IF NOT EXISTS downloads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  version TEXT NOT NULL,
  ts TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_plugins_downloads ON plugins(downloads DESC);
