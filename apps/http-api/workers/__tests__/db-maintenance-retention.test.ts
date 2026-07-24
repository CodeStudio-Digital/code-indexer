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

  it('skips passes whose tables are missing (trimmed per-project DB) without throwing', async () => {
    const { db } = fakeDb(['coder_turn_telemetry']); // everything else absent
    const res = await runRetention(db, { retentionDays: 90, pauseMs: 0 });
    expect(Object.keys(res.counts)).toEqual(['coder_turn_telemetry']);
    expect(res.skipped).toEqual([
      'session_events',
      'baselines_closed',
      'baselines_orphaned',
    ]);
  });

  it('binds the right cutoff kind per pass: text for created_at, ms for at_ms, none for orphans', async () => {
    const tables = ['coder_turn_telemetry', 'session_events', 'session_file_baselines', 'coder_sessions'];
    const { db, runs } = fakeDb(tables, {
      coder_turn_telemetry: [3],
      session_events: [2],
      session_file_baselines: [4],
    });
    const now = Date.UTC(2026, 6, 20);
    const res = await runRetention(db, { retentionDays: 90, nowMs: now, pauseMs: 0 });
    expect(res.skipped).toEqual([]);
    expect(res.counts['coder_turn_telemetry']).toBe(3);

    const { text, ms } = retentionCutoffs(now, 90);
    const bySql = (frag: string) => runs.filter((r) => r.sql.includes(frag));
    // created_at passes bind the datetime text (+ batch size).
    expect(bySql('coder_turn_telemetry')[0]!.args[0]).toBe(text);
    // session_events binds epoch ms (at_ms column, mig 195).
    expect(bySql('session_events')[0]!.args[0]).toBe(ms);
    // Orphaned-baselines pass has NO cutoff — only the batch size.
    const orphan = runs.find((r) => r.sql.includes("status = 'active'"));
    expect(orphan!.args).toHaveLength(1);
    // The transcript tables are never touched.
    expect(runs.some((r) => r.sql.includes('coder_messages') || r.sql.includes('coder_tool_calls'))).toBe(false);
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
