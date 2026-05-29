/**
 * Migration 114 — snapshot memory fields.
 *
 * Turns snapshots into a real project-memory store by adding provenance and
 * salience:
 *   - source       : where the memory came from — 'manual' | 'agent' |
 *                    'session' | 'compaction' | 'index'. Lets retrieval and
 *                    UI distinguish hand-written notes from agent/session-
 *                    derived memory and from the on-index structural facts.
 *   - importance   : 0..1 salience used to rank retrieval (relevance ×
 *                    importance) and to decide what survives consolidation.
 *   - last_accessed_at / access_count : usage signal for future decay /
 *                    "frequently useful" ranking; bumped on retrieval.
 *
 * Additive (mirrors migration 027's ALTER TABLE projects pattern). Existing
 * rows default to source='manual', importance=0.5.
 */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './index.js';

type DB = InstanceType<typeof DatabaseConstructor>;

export const snapshotMemory114: Migration = {
  version: 114,
  name: 'snapshot_memory',
  up: (db: DB): void => {
    const cols = db.prepare(`PRAGMA table_info(snapshots)`).all() as Array<{ name: string }>;
    const has = (n: string) => cols.some((c) => c.name === n);
    if (!has('source')) db.exec(`ALTER TABLE snapshots ADD COLUMN source TEXT NOT NULL DEFAULT 'manual'`);
    if (!has('importance')) db.exec(`ALTER TABLE snapshots ADD COLUMN importance REAL NOT NULL DEFAULT 0.5`);
    if (!has('last_accessed_at')) db.exec(`ALTER TABLE snapshots ADD COLUMN last_accessed_at TEXT`);
    if (!has('access_count')) db.exec(`ALTER TABLE snapshots ADD COLUMN access_count INTEGER NOT NULL DEFAULT 0`);
  },
};
