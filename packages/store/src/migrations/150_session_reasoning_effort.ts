/**
 * Migration 150 — `coder_sessions.reasoning_effort_override`.
 *
 * Per-session sticky reasoning-effort override (e.g. `minimal`/`low`/`medium`/
 * `high`/`xhigh`). Orthogonal to the thinking toggle: a session can run with
 * thinking ON *and* a specific effort level. When NULL, the provider falls back
 * to the `thinking`-derived effort, then to the model's `default_reasoning_level`.
 *
 * Only meaningful for models that expose discrete effort levels
 * (`provider_models.supported_reasoning_levels`) — the composer hides the
 * selector otherwise. Stored as TEXT; validation lives at the write path
 * (PATCH `/api/coder/sessions/:id/reasoning-effort`) and the provider degrades
 * an unsupported value gracefully to the derived behaviour.
 *
 * Mirrors migration 057 (`temperature_override`).
 */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './index.js';

type DB = InstanceType<typeof DatabaseConstructor>;

function addColumnIfMissing(db: DB, table: string, column: string, definition: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (cols.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

export const sessionReasoningEffort150: Migration = {
  version: 150,
  name: 'session_reasoning_effort',
  up: (db: DB): void => {
    addColumnIfMissing(db, 'coder_sessions', 'reasoning_effort_override', 'TEXT');
  },
};
