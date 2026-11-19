import type { AgentMemoryRow } from '@mcp/shared/types.js';
import type { DB } from './types.js';

export interface MemoryEvolutionScope { scope: 'project' | 'user'; projectId: number }
export interface MemoryEvolutionResult {
  reviewed: number; merged: number; refined: number; retired: number; rejected: number;
}
interface State {
  cursor_id: number; lease_token: string | null; lease_until: number; next_at: number;
  finished_at: number | null; failures: number; last_error: string | null; last_result: string | null;
}

/** Durable cursor + expiring ownership. An uncommitted/failed review never consumes input. */
export class AgentMemoryEvolutionStore {
  constructor(private readonly db: DB) {}

  status(key: MemoryEvolutionScope, now = Date.now()) {
    const state = this.read(key);
    const pending = this.db.prepare(`SELECT COUNT(*) AS n FROM agent_memory
      WHERE scope=? AND project_id=? AND archived_at IS NULL AND source <> 'consolidation' AND id>?`)
      .get(key.scope, key.projectId, state?.cursor_id ?? 0) as { n: number };
    return { pending: pending.n, running: (state?.lease_until ?? 0) > now,
      nextAt: state?.next_at || null, lastAt: state?.finished_at ?? null,
      errorCode: state?.last_error ?? null,
      lastResult: state?.last_result ? JSON.parse(state.last_result) as MemoryEvolutionResult : null };
  }

  read(key: MemoryEvolutionScope): State | undefined {
    return this.db.prepare('SELECT * FROM agent_memory_evolution WHERE scope=? AND project_id=?')
      .get(key.scope, key.projectId) as State | undefined;
  }

  pendingScopes(now: number, limit = 2): MemoryEvolutionScope[] {
    return (this.db.prepare(`SELECT m.scope, m.project_id FROM agent_memory m
      JOIN projects p ON p.id=m.project_id
      LEFT JOIN agent_memory_evolution s ON s.scope=m.scope AND s.project_id=m.project_id
      WHERE m.archived_at IS NULL AND m.source <> 'consolidation' AND m.scope IN ('project','user')
        AND COALESCE(p.memory_enabled,1)<>0 AND m.id>COALESCE(s.cursor_id,0)
        AND COALESCE(s.next_at,0)<=? AND COALESCE(s.lease_until,0)<=?
      GROUP BY m.scope,m.project_id ORDER BY COALESCE(s.finished_at,0),m.project_id LIMIT ?`)
      .all(now, now, limit) as Array<{ scope: 'project' | 'user'; project_id: number }>)
      .map(row => ({ scope: row.scope, projectId: row.project_id }));
  }

  claim(key: MemoryEvolutionScope, token: string, now: number, force = false): boolean {
    return this.db.transaction(() => {
      this.db.prepare('INSERT OR IGNORE INTO agent_memory_evolution(scope,project_id) VALUES (?,?)').run(key.scope, key.projectId);
      return this.db.prepare(`UPDATE agent_memory_evolution SET lease_token=?,lease_until=?
        WHERE scope=? AND project_id=? AND lease_until<=? AND (? OR next_at<=?)`)
        .run(token, now + 180_000, key.scope, key.projectId, now, force ? 1 : 0, now).changes === 1;
    })();
  }

  sources(key: MemoryEvolutionScope, limit = 8): AgentMemoryRow[] {
    return this.db.prepare(`SELECT * FROM agent_memory WHERE scope=? AND project_id=?
      AND archived_at IS NULL AND source <> 'consolidation' AND id>?
      ORDER BY id LIMIT ?`).all(key.scope, key.projectId, this.read(key)?.cursor_id ?? 0, limit) as AgentMemoryRow[];
  }

  assertOwned(key: MemoryEvolutionScope, token: string, now: number): void {
    const state = this.read(key);
    if (state?.lease_token !== token || state.lease_until <= now) throw new Error('memory_evolution_lease_lost');
  }

  complete(key: MemoryEvolutionScope, token: string, cursor: number, result: MemoryEvolutionResult, now: number, cooldownMs: number): void {
    this.assertOwned(key, token, now);
    this.db.prepare(`UPDATE agent_memory_evolution SET cursor_id=MAX(cursor_id,?),lease_token=NULL,
      lease_until=0,next_at=?,finished_at=?,failures=0,last_error=NULL,last_result=? WHERE scope=? AND project_id=?`)
      .run(cursor, now + cooldownMs, now, JSON.stringify(result), key.scope, key.projectId);
  }

  fail(key: MemoryEvolutionScope, token: string, code: string, now: number): void {
    this.db.prepare(`UPDATE agent_memory_evolution SET lease_token=NULL,lease_until=0,
      next_at=?,failures=failures+1,last_error=? WHERE scope=? AND project_id=? AND lease_token=?`)
      .run(now + Math.min(3_600_000, 300_000 * 2 ** Math.min(this.read(key)?.failures ?? 0, 4)), code, key.scope, key.projectId, token);
  }
}
