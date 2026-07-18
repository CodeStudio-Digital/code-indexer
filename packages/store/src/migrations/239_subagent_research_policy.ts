/** Persist the soft research contract used by ephemeral subagents. */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './index.js';

type DB = InstanceType<typeof DatabaseConstructor>;

function columns(db: DB): Set<string> {
  const table = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='coder_subagent_runs'",
  ).get();
  if (!table) return new Set();
  return new Set(
    (db.prepare('PRAGMA table_info(coder_subagent_runs)').all() as Array<{ name: string }>).map((row) => row.name),
  );
}

export const subagentResearchPolicy239: Migration = {
  version: 239,
  name: 'subagent_research_policy',
  up(db: DB): void {
    const existing = columns(db);
    if (existing.size === 0) return; // trimmed project DB
    if (!existing.has('research_depth')) {
      db.exec('ALTER TABLE coder_subagent_runs ADD COLUMN research_depth TEXT');
    }
    if (!existing.has('soft_tool_target')) {
      db.exec('ALTER TABLE coder_subagent_runs ADD COLUMN soft_tool_target INTEGER');
    }
    if (!existing.has('soft_time_target_ms')) {
      db.exec('ALTER TABLE coder_subagent_runs ADD COLUMN soft_time_target_ms INTEGER');
    }
    if (!existing.has('synthesis_nudged')) {
      db.exec('ALTER TABLE coder_subagent_runs ADD COLUMN synthesis_nudged INTEGER NOT NULL DEFAULT 0');
    }
  },
};
