/**
 * SubAgentResultCacheStore — CRUD over the cached sub-agent results table
 * (migration 081).
 *
 * Caller computes the (prompt_hash, context_digest, agent_type) triple and
 * calls `lookup(...)`; on miss, runs the sub-agent and stores the result.
 * Subsequent identical calls within the TTL return the cached row.
 */
import type DatabaseConstructor from 'better-sqlite3';

type DB = InstanceType<typeof DatabaseConstructor>;

export interface SubAgentCacheRow {
  id: number;
  session_id: number | null;
  prompt_hash: string;
  context_digest: string;
  agent_type: string;
  result_json: string;
  hit_count: number;
  ttl_seconds: number;
  created_at: string;
  last_used_at: string;
}

export interface SubAgentCacheInsert {
  session_id?: number | null;
  prompt_hash: string;
  context_digest: string;
  agent_type: string;
  result_json: string;
  ttl_seconds: number;
}

export class SubAgentResultCacheStore {
  constructor(private db: DB) {}

  /**
   * Find a non-expired row for this key. Updates `hit_count` and
   * `last_used_at` on hit. Returns null on miss.
   */
  lookup(opts: {
    prompt_hash: string;
    context_digest: string;
    agent_type: string;
    now?: Date;
  }): SubAgentCacheRow | null {
    const row = this.db
      .prepare(
        `SELECT * FROM sub_agent_result_cache
         WHERE prompt_hash    = @prompt_hash
           AND context_digest = @context_digest
           AND agent_type     = @agent_type`,
      )
      .get(opts) as SubAgentCacheRow | undefined;
    if (!row) return null;

    // TTL check.
    const now = opts.now ?? new Date();
    const createdAtMs = new Date(row.created_at + 'Z').getTime();
    if (Number.isFinite(createdAtMs) && now.getTime() - createdAtMs > row.ttl_seconds * 1000) {
      // Expired — caller should treat as miss. We don't delete here (let the
      // sweeper handle it) but we don't bump hit_count either.
      return null;
    }

    this.db
      .prepare(
        `UPDATE sub_agent_result_cache
            SET hit_count    = hit_count + 1,
                last_used_at = datetime('now')
          WHERE id = ?`,
      )
      .run(row.id);
    return { ...row, hit_count: row.hit_count + 1 };
  }

  /**
   * Insert a new cache entry, replacing any existing row for the same
   * (prompt_hash, context_digest, agent_type) tuple.
   */
  upsert(input: SubAgentCacheInsert): number {
    const result = this.db
      .prepare(
        `INSERT INTO sub_agent_result_cache (
           session_id, prompt_hash, context_digest, agent_type,
           result_json, ttl_seconds
         ) VALUES (
           @session_id, @prompt_hash, @context_digest, @agent_type,
           @result_json, @ttl_seconds
         )
         ON CONFLICT(prompt_hash, context_digest, agent_type) DO UPDATE SET
           session_id   = excluded.session_id,
           result_json  = excluded.result_json,
           ttl_seconds  = excluded.ttl_seconds,
           created_at   = datetime('now'),
           last_used_at = datetime('now'),
           hit_count    = 0`,
      )
      .run({
        session_id: input.session_id ?? null,
        prompt_hash: input.prompt_hash,
        context_digest: input.context_digest,
        agent_type: input.agent_type,
        result_json: input.result_json,
        ttl_seconds: input.ttl_seconds,
      });
    return Number(result.lastInsertRowid);
  }

  /** Drop expired rows. Returns deleted count. */
  sweepExpired(now: Date = new Date()): number {
    const result = this.db
      .prepare(
        `DELETE FROM sub_agent_result_cache
          WHERE julianday(?) - julianday(created_at) > (ttl_seconds / 86400.0)`,
      )
      .run(now.toISOString().slice(0, 19).replace('T', ' '));
    return Number(result.changes);
  }

  /** Drop all rows for a session — useful when projects change underneath. */
  invalidateSession(sessionId: number): number {
    const result = this.db
      .prepare('DELETE FROM sub_agent_result_cache WHERE session_id = ?')
      .run(sessionId);
    return Number(result.changes);
  }

  /** Drop a specific row by id. */
  delete(id: number): boolean {
    const result = this.db
      .prepare('DELETE FROM sub_agent_result_cache WHERE id = ?')
      .run(id);
    return Number(result.changes) > 0;
  }

  /** Stats for the admin UI. */
  stats(): { totalRows: number; totalHits: number; oldestCreatedAt: string | null } {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS total_rows,
                COALESCE(SUM(hit_count), 0) AS total_hits,
                MIN(created_at) AS oldest_created_at
         FROM sub_agent_result_cache`,
      )
      .get() as { total_rows: number; total_hits: number; oldest_created_at: string | null };
    return {
      totalRows: row.total_rows,
      totalHits: row.total_hits,
      oldestCreatedAt: row.oldest_created_at,
    };
  }
}
