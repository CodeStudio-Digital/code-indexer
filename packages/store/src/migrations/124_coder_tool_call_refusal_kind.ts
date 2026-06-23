/**
 * Migration 124 — `refusal_kind` column on coder_tool_calls.
 *
 * Loop-guard refusals (tuple-hash dedup, failure-streak) synthesize a
 * tool_result with `is_error=1` even though NO real tool ran — the agent was
 * cycling and the runner blocked the call. Counting these as tool errors
 * inflated per-tool error rates: `run_command` read ~69% "error" when a big
 * chunk was the dedup / failure-streak guard refusing verbatim repeats, not
 * the command actually failing.
 *
 * `refusal_kind` (NULL on a real call) tags the synthesized refusals so
 * dashboards can separate "the tool failed" from "the guard stopped a loop".
 * Backfills existing rows from the guards' stable, content-leading markers.
 */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './index.js';

type DB = InstanceType<typeof DatabaseConstructor>;

function addColumnIfMissing(db: DB, table: string, column: string, definition: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (cols.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

export const coderToolCallRefusalKind124: Migration = {
  version: 124,
  name: 'coder_tool_call_refusal_kind',
  up: (db: DB): void => {
    addColumnIfMissing(db, 'coder_tool_calls', 'refusal_kind', 'TEXT');
    // Backfill from the guards' stable refusal-text prefixes. Only the HARD
    // refuses replace the whole result (so the marker leads the text);
    // reminders are prepended to a real result and intentionally stay NULL.
    db.exec(`
      UPDATE coder_tool_calls
         SET refusal_kind = CASE
           WHEN result_text LIKE '[loop-refused%'           THEN 'dedup'
           WHEN result_text LIKE '[failure-streak REFUSED%' THEN 'failure-streak'
           ELSE refusal_kind
         END
       WHERE is_error = 1
         AND refusal_kind IS NULL
         AND (result_text LIKE '[loop-refused%'
              OR result_text LIKE '[failure-streak REFUSED%');
    `);
  },
};
