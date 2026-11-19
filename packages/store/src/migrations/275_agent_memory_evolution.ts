import type { Migration } from './types.js';

/** Shared memory maintenance state; never a session execution table. */
export const agentMemoryEvolution275: Migration = {
  version: 275,
  name: 'agent_memory_evolution',
  scope: 'central',
  up(db) {
    // Preserve old settings for rollback, but never run the retired query/filter
    // models. Memory retrieval now belongs exclusively to its semantic profile.
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='pipeline_provider_bindings'").get()) {
      db.exec("UPDATE pipeline_provider_bindings SET enabled=0 WHERE pipeline_name IN ('memory_query','memory_recall')");
    }
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='agent_memory'").get()) return;
    db.exec(`
      CREATE TABLE IF NOT EXISTS agent_memory_evolution (
        scope TEXT NOT NULL CHECK(scope IN ('project','user')),
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        cursor_id INTEGER NOT NULL DEFAULT 0,
        lease_token TEXT,
        lease_until INTEGER NOT NULL DEFAULT 0,
        next_at INTEGER NOT NULL DEFAULT 0,
        finished_at INTEGER,
        failures INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        last_result TEXT,
        PRIMARY KEY(scope, project_id)
      );
      CREATE INDEX IF NOT EXISTS idx_agent_memory_evolution_pending
        ON agent_memory(scope, project_id, id)
        WHERE archived_at IS NULL AND source <> 'consolidation';
    `);
  },
};
