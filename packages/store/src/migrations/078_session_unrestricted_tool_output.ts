/**
 * Migration 078 — `coder_sessions.unrestricted_tool_output`.
 *
 * Per-session toggle that lifts the tool-output truncation caps when set.
 * Stored as INTEGER (0|1|NULL) so callers can distinguish "never configured"
 * (NULL) from "explicitly disabled" (0). The runtime treats NULL|0 as false.
 *
 * When enabled, the runner / mcp-bridge / code_exec raise their per-call
 * truncation ceilings to a high safety bound (≈1 MB main, 500 KB subagent)
 * instead of using the production defaults (24 KB / 16 KB / 50 KB). The
 * downstream auto-compaction pass (PRUNE_MINIMUM=60k) keeps running so
 * sessions still don't blow past the model's context window.
 *
 * See:
 *   - src/core/coder/core/runner.ts (effectivePushTimeCap)
 *   - src/core/coder/tools/mcp-bridge.ts (applyOutputCap)
 *   - src/core/coder/tools/code-exec.ts (effectiveMaxOutput)
 */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './index.js';

type DB = InstanceType<typeof DatabaseConstructor>;

function addColumnIfMissing(db: DB, table: string, column: string, definition: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (cols.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

export const sessionUnrestrictedToolOutput078: Migration = {
  version: 78,
  name: 'session_unrestricted_tool_output',
  up: (db: DB): void => {
    addColumnIfMissing(db, 'coder_sessions', 'unrestricted_tool_output', 'INTEGER');
  },
};
