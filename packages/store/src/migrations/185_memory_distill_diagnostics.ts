/**
 * Migration 185 — memory distillation diagnostics + retry accounting.
 *
 * The distill log's `status` alone conflated "the LLM call broke" with
 * "the session genuinely had nothing durable" (same anti-pattern the quality
 * verdict fixed with `systemError`). These columns let the memory-health card
 * show WHY a pass came back empty:
 *   - `detail`      machine-readable refinement (`llm_error:401`, `no_facts`,
 *                   `summarizer_timeout`, `retry_cap`, `fallback_used`, …)
 *   - `provider` /
 *     `model`       the binding that actually served the pass
 *   - `raw_chars`   length of the raw LLM response (0 ⇒ the call never
 *                   produced text — credentials/routing, not content)
 *   - `duration_ms` wall-clock of the distill pass
 *   - `created_user` user-scope memories folded out of the same call
 *
 * `coder_sessions.memory_distill_attempts` counts consecutive FAILED sweeps
 * for the span past the high-water mark, so the sweeper can retry a failed
 * span (boundary no longer advances on error) with backoff and a hard cap
 * instead of burning the content forever on the first failure.
 */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './types.js';

type DB = InstanceType<typeof DatabaseConstructor>;

function addColumnIfMissing(db: DB, table: string, column: string, definition: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (cols.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

export const memoryDistillDiagnostics185: Migration = {
  version: 185,
  name: 'memory_distill_diagnostics',
  up: (db: DB): void => {
    const hasLog = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='memory_distill_log'")
      .get();
    if (hasLog) {
      addColumnIfMissing(db, 'memory_distill_log', 'detail', 'TEXT');
      addColumnIfMissing(db, 'memory_distill_log', 'provider', 'TEXT');
      addColumnIfMissing(db, 'memory_distill_log', 'model', 'TEXT');
      addColumnIfMissing(db, 'memory_distill_log', 'raw_chars', 'INTEGER');
      addColumnIfMissing(db, 'memory_distill_log', 'duration_ms', 'INTEGER');
      addColumnIfMissing(db, 'memory_distill_log', 'created_user', 'INTEGER NOT NULL DEFAULT 0');
    }
    const hasSessions = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='coder_sessions'")
      .get();
    if (hasSessions) {
      addColumnIfMissing(db, 'coder_sessions', 'memory_distill_attempts', 'INTEGER NOT NULL DEFAULT 0');
    }
  },
};
