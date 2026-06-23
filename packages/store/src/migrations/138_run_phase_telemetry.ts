/**
 * Migration 138 — per-run phase telemetry on `runs`.
 *
 * `phase_timings_json` holds `{scan_ms, analyze_ms, embed_ms, sweep_ms}`
 * (JSON — display data, not query data); `peak_rss_mb` is the sampled
 * process peak during the run. Both feed the perf bench and the runs UI.
 */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './index.js';

type DB = InstanceType<typeof DatabaseConstructor>;

function addColumnIfMissing(db: DB, table: string, column: string, definition: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (cols.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

export const runPhaseTelemetry138: Migration = {
  version: 138,
  name: 'run_phase_telemetry',
  up: (db: DB): void => {
    addColumnIfMissing(db, 'runs', 'phase_timings_json', 'TEXT');
    addColumnIfMissing(db, 'runs', 'peak_rss_mb', 'INTEGER');
  },
};
