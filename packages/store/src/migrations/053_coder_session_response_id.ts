/**
 * Migration 053 — `coder_sessions.last_response_id` + `last_response_message_count`.
 *
 * Lets the ChatGPT/Codex provider use `store: true` + `previous_response_id` so:
 *   - Reasoning tokens are preserved server-side between turns (40-80% better
 *     cache utilization than restating them every turn).
 *   - We can send only the *delta* of new messages instead of the full
 *     conversation history. `last_response_message_count` tracks how many
 *     messages were already on the server side when the prior `response.id`
 *     was returned.
 *
 * Both columns are nullable so the schema is a no-op for non-Codex sessions.
 */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './index.js';

type DB = InstanceType<typeof DatabaseConstructor>;

function addColumnIfMissing(db: DB, table: string, column: string, definition: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (cols.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

export const coderSessionResponseId053: Migration = {
  version: 53,
  name: 'coder_session_response_id',
  up: (db: DB): void => {
    addColumnIfMissing(db, 'coder_sessions', 'last_response_id', 'TEXT');
    addColumnIfMissing(db, 'coder_sessions', 'last_response_message_count', 'INTEGER');
  },
};
