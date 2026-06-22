-- 0012_teams — organizations (the "team" in v1), members + roles, email/link
-- invites, and a per-ORG subscription that runs in PARALLEL to the per-account
-- `subscriptions` table (the effective tier is the MAX of the two, computed in the
-- pure entitlements union — existing per-account Pro users are untouched). Per-seat
-- Stripe billing (P4b) and shared workspaces (P4c) build on these tables.
CREATE TABLE organizations (
  id               TEXT PRIMARY KEY,
  slug             TEXT NOT NULL UNIQUE,
  name             TEXT NOT NULL,
  owner_account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  kind             TEXT NOT NULL DEFAULT 'team',
  created_at_ms    INTEGER NOT NULL
);
CREATE INDEX idx_orgs_owner ON organizations(owner_account_id);

CREATE TABLE org_members (
  org_id        TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  account_id    TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  role          TEXT NOT NULL,            -- owner | admin | member | viewer
  created_at_ms INTEGER NOT NULL,
  PRIMARY KEY (org_id, account_id)
);
CREATE INDEX idx_org_members_account ON org_members(account_id);

CREATE TABLE org_invites (
  id              TEXT PRIMARY KEY,
  org_id          TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email_canonical TEXT,                   -- optional target (lowercased); link works regardless
  role            TEXT NOT NULL,
  token_hash      TEXT NOT NULL UNIQUE,   -- sha-256 of the opaque invite token
  status          TEXT NOT NULL DEFAULT 'pending', -- pending | accepted | revoked
  invited_by      TEXT NOT NULL,
  expires_at_ms   INTEGER NOT NULL,
  created_at_ms   INTEGER NOT NULL
);
CREATE INDEX idx_org_invites_org ON org_invites(org_id);

CREATE TABLE org_subscriptions (
  org_id                 TEXT PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  plan                   TEXT NOT NULL DEFAULT 'free',  -- free | team | enterprise
  status                 TEXT NOT NULL DEFAULT 'none',
  period_end_ms          INTEGER,
  seats                  INTEGER NOT NULL DEFAULT 1,     -- purchased writer seats (Stripe quantity)
  trial_used             INTEGER NOT NULL DEFAULT 0,
  stripe_customer_id     TEXT,
  stripe_subscription_id TEXT,
  updated_at_ms          INTEGER NOT NULL
);
