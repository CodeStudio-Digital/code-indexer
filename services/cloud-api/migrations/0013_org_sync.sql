-- 0013_org_sync — shared team workspaces: an ORG-scoped sync feed (the same
-- whole-document LWW model as personal sync, but owned by an organization and
-- read/written by its members). Holds shared collections / environment structure
-- / knowledge (team memory that conditions every member's agent). Writes are
-- role-gated (viewers read-only) and the org must be on a team tier; both enforced
-- at the route. Mirrors sync_documents, keyed by org_id. Forward-only.
CREATE TABLE org_sync_documents (
  org_id        TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL,              -- collection | environment | memory | note
  client_doc_id TEXT NOT NULL,
  version       INTEGER NOT NULL,           -- per-org monotonic feed sequence
  body_json     TEXT,
  body_sha256   TEXT NOT NULL,
  deleted       INTEGER NOT NULL DEFAULT 0,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (org_id, kind, client_doc_id)
);
CREATE INDEX idx_org_sync_feed ON org_sync_documents(org_id, version);

CREATE TABLE org_sync_document_versions (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL,
  kind          TEXT NOT NULL,
  client_doc_id TEXT NOT NULL,
  version       INTEGER NOT NULL,
  body_json     TEXT,
  body_sha256   TEXT NOT NULL,
  reason        TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL
);
CREATE INDEX idx_org_sync_doc_versions ON org_sync_document_versions(org_id, kind, client_doc_id, version);
