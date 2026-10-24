/**
 * Migration 264 — restore telemetry specifically for structural runs.
 *
 * Migration 232 removed the old mixed LLM/structural telemetry. `runs` now
 * contains structural reconciliations only, so these two columns have a single
 * meaning: scanner/parser/writer/sweep wall time and worker-process RSS.
 */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './types.js';

type DB = InstanceType<typeof DatabaseConstructor>;

function addColumnIfMissing(db: DB, column: string, definition: string): void {
  const columns = new Set(
    (db.prepare('PRAGMA table_info(runs)').all() as Array<{ name: string }>)
      .map((row) => row.name),
  );
  if (!columns.has(column)) db.exec(`ALTER TABLE runs ADD COLUMN ${column} ${definition}`);
}

export const structuralRunPhaseTelemetry264: Migration = {
  version: 264,
  name: 'structural_run_phase_telemetry',
  up(db: DB): void {
    addColumnIfMissing(db, 'phase_timings_json', 'TEXT');
    addColumnIfMissing(db, 'peak_rss_mb', 'INTEGER');
  },
};
