import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './types.js';

type DB = InstanceType<typeof DatabaseConstructor>;

/**
 * Physical provider-attempt audit trail.
 *
 * `coder_turn_telemetry` intentionally remains one row per successful logical
 * model turn. This table records every upstream request, including 429/5xx
 * failures that are later hidden by a successful runner retry.
 */
export const providerAttemptTelemetry253: Migration = {
  version: 253,
  name: 'provider_attempt_telemetry',
  up(db: DB): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS coder_provider_attempts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id INTEGER REFERENCES coder_sessions(id) ON DELETE CASCADE,
        project_id INTEGER,
        run_id TEXT NOT NULL,
        turn INTEGER NOT NULL,
        attempt INTEGER NOT NULL,
        provider TEXT,
        model TEXT,
        status INTEGER,
        ok INTEGER NOT NULL DEFAULT 0,
        generation_id TEXT,
        request_id TEXT,
        upstream_provider TEXT,
        input_tokens INTEGER,
        output_tokens INTEGER,
        cached_tokens INTEGER,
        cost_usd REAL,
        retry_after TEXT,
        error_code TEXT,
        error_message TEXT,
        duration_ms INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(run_id, attempt)
      );

      CREATE INDEX IF NOT EXISTS idx_coder_provider_attempts_session_created
        ON coder_provider_attempts(session_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_coder_provider_attempts_generation
        ON coder_provider_attempts(generation_id);
      CREATE INDEX IF NOT EXISTS idx_coder_provider_attempts_status
        ON coder_provider_attempts(status, created_at DESC);
    `);
  },
};
