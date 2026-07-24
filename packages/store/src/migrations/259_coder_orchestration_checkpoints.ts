import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './index.js';

type DB = InstanceType<typeof DatabaseConstructor>;

/**
 * Private, session-scoped checkpoints for local orchestration recovery.
 *
 * This is deliberately outside the control-plane journal: resume/workflow
 * payloads are bounded, redacted projections used only by the local executor.
 * They are not canonical events and are deleted by session cascade/TTL.
 */
export const coderOrchestrationCheckpoints259: Migration = {
  version: 259,
  name: 'coder_orchestration_checkpoints',
  up(db: DB): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS coder_orchestration_checkpoints (
        session_id INTEGER NOT NULL REFERENCES coder_sessions(id) ON DELETE CASCADE,
        checkpoint_kind TEXT NOT NULL CHECK (checkpoint_kind IN (
          'subagent_resume', 'workflow', 'agent_run_resolution'
        )),
        scope_id TEXT NOT NULL,
        schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version = 1),
        privacy_class TEXT NOT NULL CHECK (privacy_class IN (
          'session_private_redacted', 'metadata_only'
        )),
        payload_json TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        byte_size INTEGER NOT NULL CHECK (byte_size >= 0),
        lease_owner TEXT,
        lease_expires_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
        PRIMARY KEY (session_id, checkpoint_kind, scope_id),
        CHECK (
          (lease_owner IS NULL AND lease_expires_at IS NULL)
          OR (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)
        )
      );

      CREATE INDEX IF NOT EXISTS idx_coder_orchestration_checkpoints_expiry
        ON coder_orchestration_checkpoints(expires_at);
      CREATE INDEX IF NOT EXISTS idx_coder_orchestration_checkpoints_session
        ON coder_orchestration_checkpoints(session_id, checkpoint_kind, updated_at DESC);
    `);
  },
};
