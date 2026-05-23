/**
 * Migration 102 — `output_chars_shaped` column on coder_tool_calls.
 *
 * The existing `output_chars` records the RAW tool output length (what
 * the tool produced). With smart reducers (per-tool truncation) and the
 * generic push-time cap, the LLM often sees a SHORTER version. The
 * difference is real context-window savings, but until now we threw it
 * away after the turn loop.
 *
 * `output_chars_shaped` records the size the LLM actually saw — i.e.,
 * after applySmartReducer + buildToolResultBlock cap. The savings per
 * tool call is `output_chars - output_chars_shaped`, aggregated across
 * a session for the dashboard's "tokens saved" widget.
 *
 * NULL on pre-migration rows; the savings query treats NULL as "no
 * shaping recorded, assume no savings" by COALESCEing to `output_chars`.
 */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './index.js';

type DB = InstanceType<typeof DatabaseConstructor>;

function addColumnIfMissing(db: DB, table: string, column: string, definition: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (cols.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

export const coderToolCallsOutputCharsShaped102: Migration = {
  version: 102,
  name: 'coder_tool_calls_output_chars_shaped',
  up: (db: DB): void => {
    addColumnIfMissing(db, 'coder_tool_calls', 'output_chars_shaped', 'INTEGER');
  },
};
