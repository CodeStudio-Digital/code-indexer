/**
 * Node-pure tests for the db-maintenance retention core. The worker exports
 * the pruning logic over a minimal `MaintenanceDb` precisely so this suite
 * runs without the Electron-ABI better-sqlite3 build.
 */
import { describe, it, expect } from 'vitest';
import {
  drainDelete,
  retentionCutoffs,
  runRetention,
  tableExists,
  type MaintenanceDb,
  type StatementLike,
} from '../db-maintenance-worker.js';

/** Fake DB: table presence + a per-SQL queue of `changes` for DELETE runs. */
function fakeDb(tables: string[], deleteChanges: Record<string, number[]> = {}): {
  db: MaintenanceDb;
  runs: Array<{ sql: string; args: unknown[] }>;
} {
  const runs: Array<{ sql: string; args: unknown[] }> = [];
  const db: MaintenanceDb = {
    prepare(sql: string): StatementLike {
      if (sql.includes('sqlite_master')) {
        return {
          run: () => ({ changes: 0 }),
          get: (...args: unknown[]) => (tables.includes(String(args[0])) ? { name: args[0] } : undefined),
        };
      }
      const key = Object.keys(deleteChanges).find((k) => sql.includes(k)) ?? '';
      const queue = deleteChanges[key] ?? [0];
      return {
        run: (...args: unknown[]) => {
          runs.push({ sql, args });
          return { changes: queue.length > 1 ? queue.shift()! : queue[0] };
        },
        get: () => undefined,
      };
    },
  };
  return { db, runs };
}

describe('retentionCutoffs', () => {
  it('produces the sqlite datetime() text shape and the epoch-ms cutoff', () => {
    const now = Date.UTC(2026, 6, 20, 12, 0, 0); // 2026-07-20 12:00:00Z
    const { text, ms } = retentionCutoffs(now, 90);
    expect(text).toBe('2026-04-21 12:00:00');
    expect(ms).toBe(now - 90 * 86_400_000);
  });
});

describe('drainDelete', () => {
  it('loops full batches until a short one, passing the batch size as the last param', async () => {
    const { db, runs } = fakeDb(['t'], { 'DELETE FROM t': [5000, 5000, 120] });
    const total = await drainDelete(db, 'DELETE FROM t WHERE x < ? LIMIT ?', ['cut'], 5000, 0);
    expect(total).toBe(10_120);
    expect(runs).toHaveLength(3);
    expect(runs[0]!.args).toEqual(['cut', 5000]);
  });
});

describe('runRetention', () => {
  it('retentionDays <= 0 disables everything', async () => {
    const { db, runs } = fakeDb(['coder_turn_telemetry']);
    const res = await runRetention(db, { retentionDays: 0 });
    expect(res.counts).toEqual({});
    expect(runs).toHaveLength(0);
  });

  it('has no SQLite session-retention passes after the filesystem cutover', async () => {
    const legacySessionTables = [
      'coder_turn_telemetry',
      'session_events',
      'session_file_baselines',
      'coder_sessions',
    ];
    const { db, runs } = fakeDb(legacySessionTables);
    const res = await runRetention(db, { retentionDays: 90, pauseMs: 0 });
    expect(res.counts).toEqual({});
    expect(res.skipped).toEqual([]);
    expect(runs).toEqual([]);
  });
});

describe('tableExists', () => {
  it('true/false per catalog and never throws on a broken handle', () => {
    const { db } = fakeDb(['a']);
    expect(tableExists(db, 'a')).toBe(true);
    expect(tableExists(db, 'b')).toBe(false);
    const broken: MaintenanceDb = { prepare: () => { throw new Error('closed'); } };
    expect(tableExists(broken, 'a')).toBe(false);
  });
});
