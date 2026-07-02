/**
 * Migration 186 — `error_class` column on coder_tool_calls.
 *
 * The 2026-07 tool audit (docs/audit/TOOL_AUDIT.md, F6) found high per-tool
 * error rates (run_command 20.4%, edit_file 14.2%) but `is_error` is binary —
 * there is no way to tell "the command exited non-zero" from "the model passed
 * a bad path" from "the network was down" without reading every result_text.
 *
 * `error_class` tags REAL tool errors with a coarse machine-readable class
 * (unknown_tool / invalid_args / not_found / command_failed / network /
 * timeout / policy / handler_exception / other). It is NULL on success rows
 * AND on synthesized harness refusals — those already carry `refusal_kind`
 * (mig 124); analytics should read COALESCE(refusal_kind, error_class).
 * Classification happens at insert time (store + dbWriter worker) via
 * classifyToolError(); no backfill — the heuristics are tuned for current
 * message shapes and old rows can be re-derived from result_text if needed.
 */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './index.js';

type DB = InstanceType<typeof DatabaseConstructor>;

function tableExists(db: DB, table: string): boolean {
  return !!db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
    .get(table);
}

function addColumnIfMissing(db: DB, table: string, column: string, definition: string): void {
  if (!tableExists(db, table)) return;
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (cols.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

export const coderToolCallsErrorClass186: Migration = {
  version: 186,
  name: 'coder_tool_calls_error_class',
  up: (db: DB): void => {
    addColumnIfMissing(db, 'coder_tool_calls', 'error_class', 'TEXT');
  },
};
