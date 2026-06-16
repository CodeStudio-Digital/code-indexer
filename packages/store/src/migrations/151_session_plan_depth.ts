/**
 * Migration 151 — `coder_sessions.plan_depth_override`.
 *
 * Per-session sticky plan-depth override for the `plan` agent: `simple` |
 * `normal` | `complex`. Drives how deeply the planning agent investigates and
 * how large the produced plan should be (a target ceiling, not a quota — a
 * trivial task gets a small plan even in `complex`). When NULL, the runner
 * defaults to `normal`.
 *
 * Unlike `reasoning_effort_override` (mig 150) — which becomes a provider
 * sampling parameter — this value feeds the SYSTEM PROMPT (a cache-stable
 * axis above SYSTEM_PROMPT_DYNAMIC_BOUNDARY). Only meaningful while the active
 * agent is `plan`; the composer hides the selector otherwise. Stored as TEXT;
 * validation lives at the write path (PATCH `/api/coder/sessions/:id/plan-depth`).
 *
 * Mirrors migration 150 (`reasoning_effort_override`).
 */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './index.js';

type DB = InstanceType<typeof DatabaseConstructor>;

function addColumnIfMissing(db: DB, table: string, column: string, definition: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (cols.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

export const sessionPlanDepth151: Migration = {
  version: 151,
  name: 'session_plan_depth',
  up: (db: DB): void => {
    addColumnIfMissing(db, 'coder_sessions', 'plan_depth_override', 'TEXT');
  },
};
