import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './types.js';

type DB = InstanceType<typeof DatabaseConstructor>;

/**
 * Durable Policy Engine evaluation latency (Fase 2.5).
 *
 * Adds `evaluation_ms` to `policy_decision_comparisons` so the shadow
 * burn-in can report evaluation-overhead percentiles (p50/p95/p99) from the
 * admin endpoint without a worker→main RPC, and so the samples survive
 * restarts. Guarded by PRAGMA table_info because SQLite has no
 * `ADD COLUMN IF NOT EXISTS`.
 */
export const policyComparisonLatency256: Migration = {
  version: 256,
  name: 'policy_comparison_latency',
  up(db: DB): void {
    const columns = (db.prepare('PRAGMA table_info(policy_decision_comparisons)').all() as Array<{ name: string }>)
      .map((row) => row.name);
    // `policy_decision_comparisons` ∈ CENTRAL_DROP_TABLES — on a per-project DB the
    // table is trimmed away, so table_info returns [] and the ALTER below would
    // throw `no such table` (see project-db/trim/drop-list.ts and migration 175).
    if (columns.length === 0) return;
    if (!columns.includes('evaluation_ms')) {
      db.exec('ALTER TABLE policy_decision_comparisons ADD COLUMN evaluation_ms REAL');
    }
  },
};
