/**
 * Migration 093 — sanitized provider request/response metadata per turn.
 *
 * Stores the same kind of operational fields Claude surfaces around model
 * calls: actual API model, max_tokens, beta flags, request-id, response status,
 * retry hints, and rate-limit headers. It deliberately excludes auth headers,
 * raw request bodies, prompts, messages, tool inputs, and response text.
 */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './index.js';

type DB = InstanceType<typeof DatabaseConstructor>;

function columnExists(db: DB, table: string, column: string): boolean {
  const rows = db
    .prepare(`PRAGMA table_info(${table})`)
    .all() as { name: string }[];
  return rows.some((r) => r.name === column);
}

function addColumnIfMissing(db: DB, column: string, ddl: string): void {
  if (!columnExists(db, 'coder_turn_telemetry', column)) {
    db.exec(`ALTER TABLE coder_turn_telemetry ADD COLUMN ${ddl}`);
  }
}

export const turnRequestResponseMeta093: Migration = {
  version: 93,
  name: 'turn_request_response_meta',
  up: (db: DB): void => {
    addColumnIfMissing(db, 'request_api_model', 'request_api_model TEXT');
    addColumnIfMissing(db, 'request_requested_model', 'request_requested_model TEXT');
    addColumnIfMissing(db, 'request_display_model', 'request_display_model TEXT');
    addColumnIfMissing(db, 'request_max_tokens', 'request_max_tokens INTEGER');
    addColumnIfMissing(db, 'request_stream', 'request_stream INTEGER');
    addColumnIfMissing(db, 'request_betas_json', 'request_betas_json TEXT');
    addColumnIfMissing(db, 'request_thinking_type', 'request_thinking_type TEXT');
    addColumnIfMissing(db, 'request_effort', 'request_effort TEXT');
    addColumnIfMissing(db, 'response_status', 'response_status INTEGER');
    addColumnIfMissing(db, 'response_ok', 'response_ok INTEGER');
    addColumnIfMissing(db, 'response_request_id', 'response_request_id TEXT');
    addColumnIfMissing(db, 'response_retry_after', 'response_retry_after TEXT');
    addColumnIfMissing(db, 'response_x_should_retry', 'response_x_should_retry TEXT');
    addColumnIfMissing(db, 'response_rate_limits_json', 'response_rate_limits_json TEXT');
    addColumnIfMissing(db, 'response_path', 'response_path TEXT');

    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_coder_turn_telemetry_request_api_model
        ON coder_turn_telemetry(request_api_model);
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_coder_turn_telemetry_response_status
        ON coder_turn_telemetry(response_status);
    `);
  },
};
