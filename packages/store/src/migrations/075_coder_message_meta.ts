/**
 * Migration 075 — `is_meta` flag on coder_messages.
 *
 * PR-4 (Row 8 from docs/agent-research/COMPARISON.md). Synthetic user
 * messages injected by the runner (stop-guard nudge, auto-continue recap,
 * subordinate deliverable reminder, plan-mode "continue investigation"
 * note) should be hidden from the user-visible transcript while the model
 * still sees them in context. This column lets the dashboard filter them
 * cleanly without parsing message text.
 *
 * Default 0 — existing rows are treated as non-meta; new synthetic pushes
 * write 1.
 */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './types.js';

type DB = InstanceType<typeof DatabaseConstructor>;

function addColumnIfMissing(db: DB, table: string, column: string, definition: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (cols.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

export const coderMessageMeta075: Migration = {
  version: 75,
  name: 'coder_message_meta',
  up: (db: DB): void => {
    addColumnIfMissing(db, 'coder_messages', 'is_meta', 'INTEGER NOT NULL DEFAULT 0');
  },
};
