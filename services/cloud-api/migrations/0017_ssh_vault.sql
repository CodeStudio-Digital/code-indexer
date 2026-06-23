-- 0017_ssh_vault — zero-knowledge key distribution for the shared SSH vault.
--
-- The shared host RECORDS ride the existing org_sync_documents feed (kind
-- 'ssh_host'), encrypted client-side with a per-project Team Vault Key (TVK).
-- This migration adds only the key-distribution tables:
--
--   member_keys      — each member's published ECDH public key (so admins can
--                      wrap the TVK to them). The private key never reaches the
--                      server (it's wrapped under the member's personal KEK).
--   org_vault_grants — the TVK wrapped to one member, per shared project. Only a
--                      grant holder can decrypt; the server stays zero-knowledge.

CREATE TABLE IF NOT EXISTS member_keys (
  account_id    TEXT PRIMARY KEY,
  public_spki   TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS org_vault_grants (
  org_id               TEXT NOT NULL,
  project_workspace_id TEXT NOT NULL,
  account_id           TEXT NOT NULL,
  wrapped_key          TEXT NOT NULL,
  granter_pub          TEXT NOT NULL,
  tvk_id               TEXT NOT NULL,
  -- Grant authentication: the granter's ECDSA signing pubkey + a signature over
  -- (tvk_id || recipient_pub || wrapped_key). The recipient verifies against the
  -- granter's PINNED signing key, so the server can't forge/substitute a grant.
  granter_sig_pub      TEXT NOT NULL DEFAULT '',
  signature            TEXT NOT NULL DEFAULT '',
  created_at_ms        INTEGER NOT NULL,
  PRIMARY KEY (org_id, project_workspace_id, account_id)
);
CREATE INDEX IF NOT EXISTS idx_org_vault_grants_account ON org_vault_grants(account_id);
