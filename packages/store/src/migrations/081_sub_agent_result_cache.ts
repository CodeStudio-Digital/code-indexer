/**
 * Migration 081 — sub-agent result cache.
 *
 * Caches the OUTPUT of Explore / Plan / general-purpose sub-agents keyed by
 * (prompt_hash, context_digest, agent_type). When a user (or a master
 * orchestrator) asks the same question with the same surrounding context,
 * we return the cached answer instantly instead of spinning up a fresh
 * sub-agent run.
 *
 * Why context_digest: prompt alone isn't enough — "explore the auth flow"
 * means different things in different projects. context_digest captures
 * the projects + recent file mutations + agent kind so semantically the
 * same call shares a cache key.
 *
 * TTL is per-agent-type — Plan answers go stale faster than Explore.
 */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './types.js';

type DB = InstanceType<typeof DatabaseConstructor>;

export const subAgentResultCache081: Migration = {
  version: 81,
  name: 'sub_agent_result_cache',
  up: (db: DB): void => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS sub_agent_result_cache (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id     INTEGER,
        prompt_hash    TEXT NOT NULL,
        context_digest TEXT NOT NULL,
        agent_type     TEXT NOT NULL,
        result_json    TEXT NOT NULL,
        hit_count      INTEGER NOT NULL DEFAULT 0,
        ttl_seconds    INTEGER NOT NULL,
        created_at     TEXT NOT NULL DEFAULT (datetime('now')),
        last_used_at   TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_sub_agent_cache_key
        ON sub_agent_result_cache(prompt_hash, context_digest, agent_type);

      CREATE INDEX IF NOT EXISTS idx_sub_agent_cache_last_used
        ON sub_agent_result_cache(last_used_at);

      CREATE INDEX IF NOT EXISTS idx_sub_agent_cache_session
        ON sub_agent_result_cache(session_id, created_at);
    `);
  },
};
