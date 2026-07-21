import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { subagentRunLifecycle248 } from '../248_subagent_run_lifecycle.js';

function columns(db: InstanceType<typeof Database>): string[] {
  return (db.prepare('PRAGMA table_info(coder_subagent_runs)').all() as Array<{ name: string }>)
    .map((row) => row.name);
}

describe('migration 248 - subagent run lifecycle', () => {
  it('adds lifecycle ownership and backfills terminal state idempotently', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE coder_subagent_runs (
        id INTEGER PRIMARY KEY,
        run_id TEXT NOT NULL UNIQUE,
        started_at TEXT NOT NULL,
        completed_at TEXT
      );
      INSERT INTO coder_subagent_runs VALUES
        (1, 'running', '2026-01-01 00:00:00', NULL),
        (2, 'done', '2026-01-01 00:00:00', '2026-01-01 00:01:00');
    `);

    subagentRunLifecycle248.up(db);
    subagentRunLifecycle248.up(db);

    expect(columns(db)).toEqual(expect.arrayContaining([
      'status', 'heartbeat_at', 'worker_instance_id',
    ]));
    expect(db.prepare('SELECT run_id, status, heartbeat_at FROM coder_subagent_runs ORDER BY id').all())
      .toEqual([
        { run_id: 'running', status: 'running', heartbeat_at: '2026-01-01 00:00:00' },
        { run_id: 'done', status: 'completed', heartbeat_at: '2026-01-01 00:01:00' },
      ]);
    db.close();
  });

  it('is a no-op for trimmed project databases', () => {
    const db = new Database(':memory:');
    expect(() => subagentRunLifecycle248.up(db)).not.toThrow();
    db.close();
  });
});
