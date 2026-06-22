-- 0010_personal_sync — personal cross-device sync of CodeStudio metadata
-- (API collections, environment STRUCTURE — never secret values, memory, notes).
-- A per-account "changes feed": `version` is a per-account monotonic sequence
-- stamped on every accepted write, so pull(sinceVersion) is a simple tail read.
-- Reconciliation is whole-document last-write-wins; the superseded/conflict-loser
-- body is preserved (never silently dropped) in sync_document_versions.
-- Entitlement-gated (sync) at the route. Forward-only, idempotent.
CREATE TABLE sync_documents (
  account_id    TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL,              -- collection | environment | memory | note
  client_doc_id TEXT NOT NULL,              -- stable id minted by the client (uuid)
  version       INTEGER NOT NULL,           -- per-account monotonic feed sequence
  body_json     TEXT,                       -- canonical JSON; NULL when deleted (tombstone)
  body_sha256   TEXT NOT NULL,              -- content hash (no-op re-push detection)
  deleted       INTEGER NOT NULL DEFAULT 0,
  updated_at_ms INTEGER NOT NULL,           -- client edit time (the LWW tiebreak)
  PRIMARY KEY (account_id, kind, client_doc_id)
);
-- Pull feed: "give me everything with version > cursor", newest last.
CREATE INDEX idx_sync_docs_feed ON sync_documents(account_id, version);

-- Append-only history of superseded / conflict-losing bodies (no silent loss).
CREATE TABLE sync_document_versions (
  id            TEXT PRIMARY KEY,
  account_id    TEXT NOT NULL,
  kind          TEXT NOT NULL,
  client_doc_id TEXT NOT NULL,
  version       INTEGER NOT NULL,           -- the feed version this archive was stamped at
  body_json     TEXT,
  body_sha256   TEXT NOT NULL,
  reason        TEXT NOT NULL,              -- superseded | conflict_superseded | conflict_loser
  created_at_ms INTEGER NOT NULL
);
CREATE INDEX idx_sync_doc_versions ON sync_document_versions(account_id, kind, client_doc_id, version);
