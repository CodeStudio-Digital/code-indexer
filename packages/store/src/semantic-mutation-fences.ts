import { memoryNamespaceSource, hydrateJob } from './semantic-store-values.js';
import type { MemoryNamespaceSource, SemanticJobRow, JsonJobRow } from './semantic-store-types.js';

import type { DB } from './semantic-store-types.js';
import { SemanticJobs } from './semantic-jobs.js';
export class SemanticMutationFences {
  constructor(private readonly db: DB, private readonly jobs: SemanticJobs) {}

  /**
   * Capture source identities before an INSERT whose row id is not known yet.
   * The settled fence can then replace `*` with only rows above these durable
   * watermarks. This keeps the activation barrier pre-write without turning
   * every learned memory/investigation into a namespace-wide reconciliation.
   */
  memorySourceWatermark(namespace: string): Record<string, number> | null {
    const source = memoryNamespaceSource(namespace);
    if (!source) return null;
    try {
      const memory = source.scope === 'user'
        ? this.db.prepare(`
            SELECT COALESCE(MAX(id), 0) AS id
            FROM agent_memory
            WHERE scope = 'user' AND project_id = 0
          `).get() as { id: number }
        : this.db.prepare(`
            SELECT COALESCE(MAX(id), 0) AS id
            FROM agent_memory
            WHERE scope IN ('project', 'local') AND project_id = ?
          `).get(source.projectId) as { id: number };
      if (source.scope === 'user') {
        return { agent_memory_max_id: Number(memory.id) || 0 };
      }
      const investigation = this.db.prepare(`
        SELECT COALESCE(MAX(id), 0) AS id
        FROM coder_investigations
        WHERE project_id = ?
      `).get(source.projectId) as { id: number };
      return {
        agent_memory_max_id: Number(memory.id) || 0,
        investigation_max_id: Number(investigation.id) || 0,
      };
    } catch {
      // Older/trimmed databases may not contain both relational sources.
      // Keeping the wildcard preserves correctness during migration/recovery.
      return null;
    }
  }

  private memoryRowBelongsToNamespace(
    row: { scope: string; project_id: number; archived_at: string | null } | undefined,
    source: MemoryNamespaceSource,
  ): boolean {
    if (!row || row.archived_at !== null) return false;
    if (source.scope === 'user') return row.scope === 'user' && row.project_id === 0;
    return (row.scope === 'project' || row.scope === 'local')
      && row.project_id === source.projectId;
  }

  /**
   * Resolve a Memory fence after the relational write is visible. Wildcards
   * become post-watermark INSERT identities; exact delete fences shrink to
   * rows that actually left the live source set. Returning null deliberately
   * retains the wildcard/full-reconciliation recovery path.
   */
  private resolveMemoryMutationFence(job: SemanticJobRow): {
    cursor: Record<string, unknown>;
    expectedItems: number;
  } | null {
    const source = memoryNamespaceSource(job.namespace);
    if (!source || job.cursor?.fence_identity_resolved === true) return null;
    const rawKeys = Array.isArray(job.cursor?.item_keys)
      ? job.cursor.item_keys.filter((value): value is string => typeof value === 'string')
      : [];
    const wildcard = rawKeys.includes('*');
    const resolved = new Set(rawKeys.filter((key) => key !== '*'));

    try {
      if (wildcard) {
        const watermark = job.cursor?.memory_source_watermark;
        if (!watermark || typeof watermark !== 'object') return null;
        const values = watermark as Record<string, unknown>;
        const memoryMaxId = Number(values.agent_memory_max_id);
        if (!Number.isSafeInteger(memoryMaxId) || memoryMaxId < 0) return null;
        const memories = source.scope === 'user'
          ? this.db.prepare(`
              SELECT id FROM agent_memory
              WHERE scope = 'user' AND project_id = 0 AND id > ?
              ORDER BY id
            `).all(memoryMaxId) as Array<{ id: number }>
          : this.db.prepare(`
              SELECT id FROM agent_memory
              WHERE scope IN ('project', 'local') AND project_id = ? AND id > ?
              ORDER BY id
            `).all(source.projectId, memoryMaxId) as Array<{ id: number }>;
        for (const row of memories) resolved.add(`agent_memory:${row.id}`);

        if (source.scope === 'project') {
          const investigationMaxId = Number(values.investigation_max_id);
          if (!Number.isSafeInteger(investigationMaxId) || investigationMaxId < 0) return null;
          const investigations = this.db.prepare(`
            SELECT id FROM coder_investigations
            WHERE project_id = ? AND id > ?
            ORDER BY id
          `).all(source.projectId, investigationMaxId) as Array<{ id: number }>;
          for (const row of investigations) resolved.add(`investigation:${row.id}`);
        }
      }
      if (job.cursor?.operation === 'delete') {
        for (const key of [...resolved]) {
          const match = /^agent_memory:(\d+)$/.exec(key);
          if (!match) continue;
          const row = this.db.prepare(`
            SELECT scope, project_id, archived_at FROM agent_memory WHERE id = ?
          `).get(Number(match[1])) as {
            scope: string;
            project_id: number;
            archived_at: string | null;
          } | undefined;
          if (this.memoryRowBelongsToNamespace(row, source)) resolved.delete(key);
        }
      }
    } catch {
      return null;
    }

    const itemKeys = [...resolved];
    return {
      cursor: {
        ...(job.cursor ?? {}),
        item_keys: itemKeys,
        item_keys_truncated: false,
        fence_identity_resolved: true,
        resolved_item_count: itemKeys.length,
      },
      expectedItems: itemKeys.length,
    };
  }

  private applyResolvedMemoryFence(
    job: SemanticJobRow,
    cursor: Record<string, unknown>,
    expectedItems: number,
  ): void {
    const deltaAdjustment = expectedItems - job.expected_items;
    if (deltaAdjustment !== 0 && job.generation_id !== null) {
      this.db.prepare(`
        UPDATE semantic_namespace_generations
        SET delta_items = MAX(0, delta_items + ?), updated_at = datetime('now')
        WHERE namespace = ?
      `).run(deltaAdjustment, job.namespace);
    }
    this.db.prepare(`
      UPDATE semantic_jobs
      SET expected_items = ?, cursor = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(expectedItems, JSON.stringify(cursor), job.id);
  }

  /** Settle one durable relational-mutation fence without acknowledging it.
   * The job becomes ordinary pending delta work and is completed only by
   * `finishNamespaceMutationPass` after exact logical + physical coverage. */
  settleNamespaceMutationFence(input: {
    job_id: number;
    token: string;
    mutation_error?: string | null;
  }): SemanticJobRow | null {
    const transact = this.db.transaction((): SemanticJobRow | null => {
      const job = this.jobs.getJob(input.job_id);
      if (!job) return null;
      if (job.kind !== 'delta'
        || job.cursor?.reason !== 'mutation-fence'
        || job.cursor?.fence_token !== input.token) {
        throw new Error(`Semantic mutation fence ${input.job_id} does not match its token`);
      }
      if (job.status === 'completed' || job.status === 'cancelled' || job.status === 'failed') {
        return job;
      }
      const resolved = this.resolveMemoryMutationFence(job);
      const resolvedCursor = resolved?.cursor ?? (job.cursor ?? {});
      if (resolved) this.applyResolvedMemoryFence(job, resolvedCursor, resolved.expectedItems);
      const cursor = {
        ...resolvedCursor,
        fence_phase: 'settled',
        fence_settled_at_ms: Date.now(),
        ...(input.mutation_error ? { mutation_error: input.mutation_error } : {}),
      };
      this.db.prepare(`
        UPDATE semantic_jobs
        SET status = 'pending', cursor = ?, error = NULL, completed_at = NULL,
          updated_at = datetime('now')
        WHERE id = ?
      `).run(JSON.stringify(cursor), job.id);
      return this.jobs.getJob(job.id);
    });
    return transact.immediate();
  }

  /** Recover fences owned by a previous process. Bootstrap callers must run
   * this before accepting new mutations and order relational source recovery
   * before pending catch-up execution. Current-process fences stay untouched. */
  recoverNamespaceMutationFences(
    namespacePrefix: string,
    currentOwner: string,
    now = Date.now(),
  ): number {
    const transact = this.db.transaction((): number => {
      const rows = (this.db.prepare(`
        SELECT * FROM semantic_jobs
        WHERE namespace LIKE ? AND kind = 'delta' AND status = 'running'
      `).all(`${namespacePrefix}%`) as JsonJobRow[]).map(hydrateJob);
      let recovered = 0;
      for (const job of rows) {
        if (job.cursor?.reason !== 'mutation-fence'
          || job.cursor?.fence_owner === currentOwner) continue;
        const leaseExpiresAt = Number(job.cursor?.fence_lease_expires_at_ms);
        if (Number.isFinite(leaseExpiresAt) && leaseExpiresAt > now) continue;
        // A crash can happen after the source mutation settles and after a
        // semantic pass claims that settled delta. In that case the durable
        // row is `running` + `settled`, not `running` + `in-flight`. Both are
        // previous-process work once their lease has expired and must return
        // to the pending queue; otherwise every semantic control in the UI is
        // blocked forever by work that no process owns.
        const resolved = this.resolveMemoryMutationFence(job);
        const resolvedCursor = resolved?.cursor ?? (job.cursor ?? {});
        if (resolved) this.applyResolvedMemoryFence(job, resolvedCursor, resolved.expectedItems);
        const cursor = {
          ...resolvedCursor,
          fence_phase: 'settled',
          fence_recovered_at_ms: Date.now(),
          recovery_reason: 'process-restart',
        };
        recovered += this.db.prepare(`
          UPDATE semantic_jobs
          SET status = 'pending', cursor = ?, error = NULL, completed_at = NULL,
            updated_at = datetime('now')
          WHERE id = ? AND status = 'running'
        `).run(JSON.stringify(cursor), job.id).changes;
      }
      return recovered;
    });
    return transact.immediate();
  }
}
