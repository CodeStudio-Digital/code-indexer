-- 0005_sharing — public conversation sharing. public_shares holds the signed,
-- redacted snapshot metadata; public_share_messages is the DENORMALIZED,
-- already-redacted transcript the public viewer reads (the live conversation is
-- never queried). Timestamps are epoch ms (INTEGER) for clean arithmetic.
PRAGMA defer_foreign_keys = TRUE;

CREATE TABLE IF NOT EXISTS public_shares (
  id                 TEXT PRIMARY KEY,
  slug               TEXT NOT NULL UNIQUE,          -- 21-char unguessable id (the /s/:slug route)
  owner_account_id   TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  title              TEXT NOT NULL,
  model              TEXT,
  visibility         TEXT NOT NULL DEFAULT 'unlisted',  -- public | unlisted
  status             TEXT NOT NULL DEFAULT 'active',     -- active | revoked | expired
  snapshot_sha256    TEXT NOT NULL,                 -- hex digest of the canonical snapshot
  snapshot_signature TEXT NOT NULL,                 -- base64 Ed25519 over the digest
  message_count      INTEGER NOT NULL DEFAULT 0,
  created_at_ms      INTEGER NOT NULL,
  expires_at_ms      INTEGER,                       -- null = no expiry
  revoked_at_ms      INTEGER
);

CREATE INDEX IF NOT EXISTS idx_public_shares_owner ON public_shares(owner_account_id, created_at_ms);

-- Denormalized, ordered, ALREADY-REDACTED blocks. blocks_json is a JSON array of
-- PublicBlock — no base64, no raw tool_result body, no secrets (scrubbed on write).
CREATE TABLE IF NOT EXISTS public_share_messages (
  share_id    TEXT NOT NULL REFERENCES public_shares(id) ON DELETE CASCADE,
  idx         INTEGER NOT NULL,
  role        TEXT NOT NULL,                        -- user | assistant
  blocks_json TEXT NOT NULL,
  PRIMARY KEY (share_id, idx)
);
