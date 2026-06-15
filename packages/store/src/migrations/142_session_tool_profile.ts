/**
 * Migration 142 — sticky per-session tool profile on `coder_sessions`.
 *
 * `tool_profile` ('bootstrap' | 'navigate' | 'full', NULL → resolve once on
 * next run and adopt) pins the tier profile across runs of the same session.
 * Before this, every resume re-ran `inferProfileFromHistory` over whatever
 * tail of the history happened to be loaded, so the visible tool array
 * flip-flopped between runs (118 ↔ ~60 tools observed) and busted the entire
 * provider prompt-cache prefix on turn 1 of every round.
 *
 * `tool_state_json` holds the widen-only companion state:
 * `{v:1, extraTiers:[], pins:[], visibleCap:null}` — tiers outside the 3 core
 * profiles (master/preview/custom), pinned tools, and the preflight visible
 * cap, all merged by union so membership only ever grows.
 *
 * Idempotent (`addColumnIfMissing`) — same repair-friendly pattern as
 * migrations 129/130/131.
 */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './index.js';

type DB = InstanceType<typeof DatabaseConstructor>;

function addColumnIfMissing(db: DB, table: string, column: string, definition: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (cols.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

export const sessionToolProfile142: Migration = {
  version: 142,
  name: 'session_tool_profile',
  up: (db: DB): void => {
    addColumnIfMissing(db, 'coder_sessions', 'tool_profile', 'TEXT');
    addColumnIfMissing(db, 'coder_sessions', 'tool_state_json', 'TEXT');
  },
};
