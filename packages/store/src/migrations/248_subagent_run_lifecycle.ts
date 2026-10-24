/** Persist enough subagent liveness to distinguish a live worker from an orphan. */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './types.js';

type DB = InstanceType<typeof DatabaseConstructor>;

function columns(db: DB): Set<string> {
  const table = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='coder_subagent_runs'",
  ).get();
  if (!table) return new Set();
  return new Set(
    (db.prepare('PRAGMA table_info(coder_subagent_runs)').all() as Array<{ name: string }>)
      .map((row) => row.name),
  );
}

export const subagentRunLifecycle248: Migration = {
  version: 248,
  name: 'subagent_run_lifecycle',
  up(db: DB): void {
    const existing = columns(db);
    if (existing.size === 0) return;
    if (!existing.has('status')) {
      db.exec("ALTER TABLE coder_subagent_runs ADD COLUMN status TEXT NOT NULL DEFAULT 'running'");
    }
    if (!existing.has('heartbeat_at')) {
      db.exec('ALTER TABLE coder_subagent_runs ADD COLUMN heartbeat_at TEXT');
    }
    if (!existing.has('worker_instance_id')) {
      db.exec('ALTER TABLE coder_subagent_runs ADD COLUMN worker_instance_id TEXT');
    }

    db.exec(`
      UPDATE coder_subagent_runs
      SET status = 'completed'
      WHERE completed_at IS NOT NULL AND status = 'running';
      UPDATE coder_subagent_runs
      SET heartbeat_at = COALESCE(heartbeat_at, completed_at, started_at)
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_coder_subagent_runs_lifecycle
        ON coder_subagent_runs(status, heartbeat_at)
    `);
  },
};
