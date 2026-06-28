-- 0018_org_sso — per-org OIDC single sign-on (Enterprise). One row per org holds
-- the org's IdP config. The client SECRET is stored ENCRYPTED at rest (AES-GCM via
-- SSO_CONFIG_KEY); the worker never persists it in clear. `allowed_domains` is the
-- anti-takeover gate: an SSO login is only accepted when the verified email's
-- domain is on this list, so a misconfigured/hostile IdP can't mint accounts for
-- arbitrary domains. SSO itself is gated on the org's `sso` entitlement (Enterprise)
-- at request time; this table just holds config. FK cascades on org delete.
PRAGMA defer_foreign_keys = TRUE;

CREATE TABLE IF NOT EXISTS org_sso_config (
  org_id            TEXT PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  issuer            TEXT NOT NULL,          -- OIDC issuer (discovery base)
  client_id         TEXT NOT NULL,
  client_secret_enc TEXT NOT NULL,          -- AES-GCM(base64url iv||ct), key = SHA-256(SSO_CONFIG_KEY)
  allowed_domains   TEXT NOT NULL,          -- csv of lowercased email domains
  enabled           INTEGER NOT NULL DEFAULT 1,
  created_at_ms     INTEGER NOT NULL,
  updated_at_ms     INTEGER NOT NULL
);
