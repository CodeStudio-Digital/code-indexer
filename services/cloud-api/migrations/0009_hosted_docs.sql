-- 0009_hosted_docs — hosted API documentation sites. A redacted, Ed25519-signed
-- OpenAPI spec addressable by an unguessable 21-char slug, served as a browsable
-- docs page at /d/:slug (public, no auth). Creation is entitlement-gated (apiDocs)
-- and per-account quota-gated. Mirrors public_shares; spec JSON is stored inline
-- (capped at ~1.5 MB by the use-case) and served verbatim to the viewer.
CREATE TABLE doc_sites (
  id               TEXT PRIMARY KEY,
  slug             TEXT NOT NULL UNIQUE,
  owner_account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  title            TEXT NOT NULL,
  description      TEXT NOT NULL DEFAULT '',
  visibility       TEXT NOT NULL DEFAULT 'unlisted',
  status           TEXT NOT NULL DEFAULT 'active',
  try_it_mode      TEXT NOT NULL DEFAULT 'off',
  spec_json        TEXT NOT NULL,
  spec_sha256      TEXT NOT NULL,
  spec_signature   TEXT NOT NULL,
  operation_count  INTEGER NOT NULL DEFAULT 0,
  created_at_ms    INTEGER NOT NULL,
  updated_at_ms    INTEGER NOT NULL,
  revoked_at_ms    INTEGER
);

CREATE INDEX idx_doc_sites_owner ON doc_sites(owner_account_id, created_at_ms);
