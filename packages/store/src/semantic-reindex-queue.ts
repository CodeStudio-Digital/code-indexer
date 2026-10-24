import { projectRemovalNamespace, parseJson, hydrateJob } from './semantic-store-values.js';
import type { SemanticPurpose, SemanticJobRow, JsonJobRow } from './semantic-store-types.js';

import type { DB } from './semantic-store-types.js';
import { SemanticJobs } from './semantic-jobs.js';
export class SemanticReindexQueue {
  constructor(private readonly db: DB, private readonly jobs: SemanticJobs) {}

  /** Enqueue (or resume) the durable control job for a purpose reindex. */
  enqueueReindexJob(purpose: SemanticPurpose): SemanticJobRow {
    const namespace = `semantic:reindex:${purpose}`;
    return this.db.transaction(() => {
      const existing = this.db.prepare(`
        SELECT * FROM semantic_jobs
        WHERE namespace = ? AND generation_id IS NULL AND kind = 'build'
          AND status IN ('pending', 'running', 'paused')
        ORDER BY id DESC LIMIT 1
      `).get(namespace) as JsonJobRow | undefined;
      if (existing) {
        if (existing.status === 'paused') {
          this.db.prepare(`
            UPDATE semantic_jobs
            SET status = 'pending', error = NULL, completed_at = NULL,
              cursor = json_remove(COALESCE(cursor, '{}'), '$.lease_owner', '$.lease_expires_at_ms'),
              updated_at = datetime('now')
            WHERE id = ? AND status = 'paused'
          `).run(existing.id);
          return this.jobs.getJob(existing.id)!;
        }
        return hydrateJob(existing);
      }
      return this.jobs.createJob({
        namespace,
        kind: 'build',
        priority: 100,
        cursor: { purpose, attempt: 0, requested_at_ms: Date.now() },
      });
    })();
  }

  /**
   * Publish the durable tombstone used by out-of-process clients before they
   * ask the server-owned vector worker to remove a project database. The
   * marker is intentionally central: a CLI process must never open/unlink a
   * vectors.db that may still be held by the running server worker.
   *
   * `finalizeProject` means the coordinator should delete the relational
   * project only after the worker drain succeeds. Repeated requests coalesce,
   * including recovery from a crash after physical cleanup but before the
   * catalog row was deleted.
   */
  requestProjectRemoval(input: {
    projectId: number;
    requestedBy?: string;
    finalizeProject?: boolean;
  }): SemanticJobRow {
    const namespace = projectRemovalNamespace(input.projectId);
    const requestedBy = input.requestedBy?.trim() || 'unknown';
    const now = Date.now();
    const transact = this.db.transaction((): SemanticJobRow => {
      const existing = this.db.prepare(`
        SELECT * FROM semantic_jobs
        WHERE namespace = ? AND generation_id IS NULL AND kind = 'cleanup'
          AND status NOT IN ('failed', 'cancelled')
        ORDER BY id DESC LIMIT 1
      `).get(namespace) as JsonJobRow | undefined;
      if (existing) {
        const hydrated = hydrateJob(existing);
        const cursor = {
          ...(hydrated.cursor ?? {}),
          reason: 'project-removal',
          projectId: input.projectId,
          requested_by: requestedBy,
          finalize_project: hydrated.cursor?.finalize_project === true || input.finalizeProject === true,
          requested_at_ms: hydrated.cursor?.requested_at_ms ?? now,
          last_requested_at_ms: now,
        };
        this.db.prepare(`
          UPDATE semantic_jobs
          SET status = CASE WHEN status = 'running' THEN status ELSE 'pending' END,
            priority = MAX(priority, 100), cursor = ?, processed_items = 0,
            failed_items = 0, error = NULL, completed_at = NULL,
            updated_at = datetime('now')
          WHERE id = ?
        `).run(JSON.stringify(cursor), hydrated.id);
        return this.jobs.getJob(hydrated.id)!;
      }
      return this.jobs.createJob({
        namespace,
        kind: 'cleanup',
        priority: 100,
        expected_items: 1,
        cursor: {
          reason: 'project-removal',
          projectId: input.projectId,
          requested_by: requestedBy,
          finalize_project: input.finalizeProject === true,
          requested_at_ms: now,
          last_requested_at_ms: now,
        },
      });
    });
    return transact.immediate();
  }

  /** A completed marker remains a tombstone until its project row is gone. */
  hasProjectRemovalRequest(projectId: number): boolean {
    return !!this.db.prepare(`
      SELECT 1 FROM semantic_jobs
      WHERE namespace = ? AND generation_id IS NULL AND kind = 'cleanup'
        AND status NOT IN ('failed', 'cancelled')
      LIMIT 1
    `).get(projectRemovalNamespace(projectId));
  }

  /** Persist one generation-less namespace backfill before a vector space can
   * be created. This is the recovery seam for corpus-first ingestion when the
   * embedding provider or semantic worker is temporarily unavailable. */
  enqueueNamespaceBackfill(input: {
    namespace: string;
    cursor?: Record<string, unknown> | null;
    priority?: number;
    error?: string | null;
  }): SemanticJobRow {
    if (!input.namespace.trim()) throw new Error('Semantic backfill namespace is required');
    return this.db.transaction(() => {
      const existing = this.db.prepare(`
        SELECT * FROM semantic_jobs
        WHERE namespace = ? AND generation_id IS NULL AND kind = 'backfill'
          AND status IN ('pending', 'running', 'paused')
        ORDER BY id DESC LIMIT 1
      `).get(input.namespace) as JsonJobRow | undefined;
      if (existing) {
        const hydrated = hydrateJob(existing);
        const cursor = { ...(hydrated.cursor ?? {}), ...(input.cursor ?? {}) };
        this.db.prepare(`
          UPDATE semantic_jobs
          SET status = CASE WHEN status = 'paused' THEN 'pending' ELSE status END,
            priority = MAX(priority, ?), cursor = ?, error = ?, completed_at = NULL,
            updated_at = datetime('now')
          WHERE id = ?
        `).run(
          input.priority ?? hydrated.priority,
          Object.keys(cursor).length > 0 ? JSON.stringify(cursor) : null,
          input.error === undefined ? hydrated.error : input.error,
          hydrated.id,
        );
        return this.jobs.getJob(hydrated.id)!;
      }
      const job = this.jobs.createJob({
        namespace: input.namespace,
        kind: 'backfill',
        priority: input.priority ?? 50,
        cursor: input.cursor,
      });
      return input.error === undefined
        ? job
        : this.jobs.updateJob(job.id, { error: input.error })!;
    })();
  }

  /**
   * Return abandoned reindex leases to the persistent queue. Namespace build
   * jobs are deliberately excluded: their lifecycle belongs to the semantic
   * coordinator, not this control-plane dispatcher.
   */
  recoverExpiredReindexJobs(nowMs = Date.now()): number {
    return this.db.prepare(`
      UPDATE semantic_jobs
      SET status = 'pending', error = 'worker lease expired; queued for recovery',
        cursor = json_remove(COALESCE(cursor, '{}'), '$.lease_owner', '$.lease_expires_at_ms'),
        updated_at = datetime('now')
      WHERE namespace IN ('semantic:reindex:code', 'semantic:reindex:docs', 'semantic:reindex:memory')
        AND generation_id IS NULL
        AND kind = 'build'
        AND status = 'running'
        AND (
          json_extract(cursor, '$.lease_expires_at_ms') IS NULL
          OR json_extract(cursor, '$.lease_expires_at_ms') <= ?
        )
    `).run(nowMs).changes;
  }

  /** Atomically lease the next durable reindex request to one worker. */
  claimNextReindexJob(
    workerId: string,
    leaseMs = 30_000,
    nowMs = Date.now(),
    purpose?: SemanticPurpose,
  ): SemanticJobRow | null {
    return this.db.transaction(() => {
      this.recoverExpiredReindexJobs(nowMs);
      const namespace = purpose ? `semantic:reindex:${purpose}` : null;
      const row = this.db.prepare(`
        SELECT * FROM semantic_jobs
        WHERE namespace IN ('semantic:reindex:code', 'semantic:reindex:docs', 'semantic:reindex:memory')
          AND generation_id IS NULL
          AND kind = 'build'
          AND status = 'pending'
          AND (? IS NULL OR namespace = ?)
        ORDER BY priority DESC, id
        LIMIT 1
      `).get(namespace, namespace) as JsonJobRow | undefined;
      if (!row) return null;
      const cursor = row.cursor ? parseJson<Record<string, unknown>>(row.cursor) : {};
      const nextCursor = {
        ...cursor,
        attempt: Math.max(0, Number(cursor.attempt) || 0) + 1,
        lease_owner: workerId,
        lease_expires_at_ms: nowMs + Math.max(1, leaseMs),
      };
      const claimed = this.db.prepare(`
        UPDATE semantic_jobs
        SET status = 'running', cursor = ?, error = NULL,
          started_at = COALESCE(started_at, datetime('now')),
          completed_at = NULL, updated_at = datetime('now')
        WHERE id = ? AND status = 'pending'
      `).run(JSON.stringify(nextCursor), row.id);
      return claimed.changes === 1 ? this.jobs.getJob(row.id) : null;
    })();
  }

  renewReindexJobLease(
    id: number,
    workerId: string,
    leaseMs = 30_000,
    nowMs = Date.now(),
  ): boolean {
    return this.db.transaction(() => {
      const job = this.jobs.getJob(id);
      if (
        !job
        || job.status !== 'running'
        || !['semantic:reindex:code', 'semantic:reindex:docs', 'semantic:reindex:memory'].includes(job.namespace)
        || job.cursor?.lease_owner !== workerId
      ) return false;
      const cursor = { ...job.cursor, lease_expires_at_ms: nowMs + Math.max(1, leaseMs) };
      return this.db.prepare(`
        UPDATE semantic_jobs SET cursor = ?, updated_at = datetime('now')
        WHERE id = ? AND status = 'running'
      `).run(JSON.stringify(cursor), id).changes === 1;
    })();
  }
}
