/**
 * Migration 133 — `parent_tool_use_id` on coder_tool_calls.
 *
 * code_exec batches up to 50 nested tool invocations per call, and every one
 * of them was INVISIBLE to telemetry: only the outer code_exec row existed
 * (3.866 historical code_exec turns, zero nested rows). The runner now emits
 * a `nested_tool_call` event per settled nested invocation; those rows land
 * here with `parent_tool_use_id` pointing at the visible code_exec block and
 * a synthetic `tool_use_id` of the form `<parent>#<seq>`.
 *
 * NULL = a normal top-level call. Nested rows are persisted ONLY as audit
 * rows — they are deliberately excluded from the paired tool-role message
 * (they have no matching `tool_use` block; including them would corrupt the
 * transcript with orphan tool_results).
 */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './types.js';

type DB = InstanceType<typeof DatabaseConstructor>;

function addColumnIfMissing(db: DB, table: string, column: string, definition: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (cols.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

export const coderToolCallsParent133: Migration = {
  version: 133,
  name: 'coder_tool_calls_parent',
  up: (db: DB): void => {
    addColumnIfMissing(db, 'coder_tool_calls', 'parent_tool_use_id', 'TEXT');
    db.exec(
      'CREATE INDEX IF NOT EXISTS idx_coder_tool_calls_parent ' +
      'ON coder_tool_calls(parent_tool_use_id) WHERE parent_tool_use_id IS NOT NULL',
    );
  },
};
