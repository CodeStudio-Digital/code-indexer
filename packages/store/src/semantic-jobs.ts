import { projectIdFromRemovalNamespace, parseJson, hydrateJob } from './semantic-store-values.js';
import type { SemanticJobKind, SemanticJobStatus, SemanticJobRow, JsonJobRow } from './semantic-store-types.js';

import type { DB } from './semantic-store-types.js';

export class SemanticJobs {
  constructor(private readonly db: DB) {}

  recoverInterruptedJobs(): void {
    const openBuild = `kind IN ('build','backfill') AND status IN ('pending','running','paused')
      AND generation_id IS NOT NULL`;
    // Thousands of jobs can share one generation. Compare distinct pairs from
    // the partial index before touching any job payload or taking a write lock.
    const obsoletePairs = `SELECT g.namespace, g.generation_id FROM
      (SELECT DISTINCT namespace, generation_id FROM semantic_jobs WHERE ${openBuild}) g
      LEFT JOIN semantic_namespace_generations n ON n.namespace = g.namespace
      WHERE g.generation_id IS NOT n.active_generation_id AND g.generation_id IS NOT n.building_generation_id`;
    const interrupted = `status = 'running' AND kind <> 'cleanup'
      AND json_extract(cursor, '$.reason') IS NOT 'mutation-fence'`;
    if (!this.db.prepare(`${obsoletePairs} LIMIT 1`).get()
      && !this.db.prepare(`SELECT 1 FROM semantic_jobs WHERE ${interrupted} LIMIT 1`).get()) return;

    this.db.transaction(() => {
      this.db.prepare(`UPDATE semantic_jobs SET status = 'cancelled',
        error = 'superseded by a newer active or building generation',
        completed_at = datetime('now'), updated_at = datetime('now')
        WHERE ${openBuild} AND (namespace, generation_id) IN (${obsoletePairs})`).run();
      this.db.prepare(`UPDATE semantic_jobs SET status = 'paused', processed_items = 0,
        error = 'interrupted by application restart; waiting for an explicit resume',
        updated_at = datetime('now') WHERE ${interrupted}`).run();
    })();
  }

  createJob(input: {
    generation_id?: number | null;
    namespace: string;
    kind: SemanticJobKind;
    priority?: number;
    cursor?: Record<string, unknown> | null;
    expected_items?: number;
  }): SemanticJobRow {
    const info = this.db.prepare(`
      INSERT INTO semantic_jobs
        (generation_id, namespace, kind, priority, cursor, expected_items)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      input.generation_id ?? null, input.namespace, input.kind, input.priority ?? 0,
      input.cursor ? JSON.stringify(input.cursor) : null, input.expected_items ?? 0,
    );
    return this.getJob(Number(info.lastInsertRowid))!;
  }

  /** Retry the same attempt instead of growing history on every failed wake-up.
   * Delta/fence jobs are independent durable watermarks and are never reused here. */
  getOrCreateBuildJob(input: {
    generation_id: number;
    namespace: string;
    kind: 'build' | 'backfill';
    priority?: number;
    cursor?: Record<string, unknown> | null;
    expected_items: number;
  }): SemanticJobRow {
    return this.db.transaction(() => {
      const running = this.db.prepare(`SELECT * FROM semantic_jobs WHERE namespace = ? AND generation_id = ?
        AND kind = ? AND status = 'running' ORDER BY id DESC LIMIT 1`).get(input.namespace, input.generation_id, input.kind) as JsonJobRow | undefined;
      if (running) return hydrateJob(running);
      const row = this.db.prepare(`
        SELECT * FROM semantic_jobs WHERE namespace = ? AND generation_id = ?
          AND kind = ? AND status IN ('pending', 'paused') ORDER BY id DESC LIMIT 1
      `).get(input.namespace, input.generation_id, input.kind) as JsonJobRow | undefined;
      if (!row) return this.createJob(input);
      const current = hydrateJob(row);
      return this.updateJob(current.id, {
        status: 'pending', expected_items: input.expected_items,
        processed_items: 0, failed_items: 0, error: null,
        cursor: { ...input.cursor, ...(current.cursor?.retry ? { retry: current.cursor.retry } : {}) },
      })!;
    }).immediate();
  }

  /** Reserve a retry and publish its running state in the same transaction. */
  claimBuildJob(input: Parameters<SemanticJobs['getOrCreateBuildJob']>[0]): SemanticJobRow | null {
    return this.db.transaction(() => {
      const job = this.getOrCreateBuildJob(input);
      return job.status === 'running' ? null : this.updateJob(job.id, { status: 'running' });
    }).immediate();
  }

  /** Checks need one boolean, not thousands of deserialized historical jobs. */
  hasLiveMutationFence(namespace: string): boolean {
    return !!this.db.prepare(`
      SELECT 1 FROM semantic_jobs WHERE namespace = ? AND status = 'running' AND kind = 'delta'
        AND json_extract(cursor, '$.reason') = 'mutation-fence'
        AND json_extract(cursor, '$.fence_phase') = 'in-flight' LIMIT 1
    `).get(namespace);
  }

  getNamespaceBuildRetry(namespace: string): { attempt: number; not_before_ms: number; blocked?: boolean } | null {
    const row = this.db.prepare(`
      SELECT json_extract(j.cursor, '$.retry') AS retry, j.error FROM semantic_jobs j
      JOIN semantic_namespace_generations n ON n.namespace = j.namespace
      WHERE j.namespace = ? AND j.kind IN ('build', 'backfill') AND j.status = 'paused'
        AND j.generation_id = COALESCE(n.building_generation_id, n.active_generation_id)
        AND json_type(j.cursor, '$.retry') = 'object'
      ORDER BY j.id DESC LIMIT 1
    `).get(namespace) as { retry: string; error: string | null } | undefined;
    if (!row) return null;
    const retry = parseJson(row.retry) as { attempt: number; not_before_ms: number; blocked?: boolean };
    // Older builds permanently latched the circuit even for a temporary free
    // quota. Preserve its cooldown but allow recovery when that window closes.
    if (/\b429\b|rate.limit|quota/i.test(row.error ?? '')) return { ...retry, blocked: false };
    return retry;
  }

  getJob(id: number): SemanticJobRow | null {
    const row = this.db.prepare(`SELECT * FROM semantic_jobs WHERE id = ?`).get(id) as JsonJobRow | undefined;
    return row ? hydrateJob(row) : null;
  }

  /**
   * `namespaces` restricts to a known set in SQL. Callers that only care about
   * specific namespaces used to pull the WHOLE table and filter in JS — an
   * unbounded `SELECT *` plus a `JSON.parse` per row (see `hydrateJob`) that
   * grows with job history and runs synchronously on the Electron main thread.
   * Chunked because SQLite caps bound parameters.
   */
  listJobs(
    filter: {
      namespace?: string;
      namespacePrefix?: string;
      generationId?: number | null;
      status?: SemanticJobStatus;
      namespaces?: readonly string[];
      statuses?: readonly SemanticJobStatus[];
      kinds?: readonly SemanticJobKind[];
      /** Keyset pagination used by the worker-owned query service. */
      afterId?: number;
      beforeId?: number;
      throughId?: number;
      limit?: number;
      order?: 'priority' | 'newest';
    } = {},
  ): SemanticJobRow[] {
    const base: string[] = [];
    const baseParams: unknown[] = [];
    for (const [name, value] of [['afterId', filter.afterId], ['beforeId', filter.beforeId], ['throughId', filter.throughId], ['limit', filter.limit]] as const) {
      if (value !== undefined && (!Number.isSafeInteger(value) || value < (name === 'limit' ? 1 : 0))) {
        throw new RangeError(`invalid semantic job ${name}`);
      }
    }
    if (filter.afterId !== undefined) { base.push('id > ?'); baseParams.push(filter.afterId); }
    if (filter.beforeId !== undefined) { base.push('id < ?'); baseParams.push(filter.beforeId); }
    if (filter.order !== undefined && filter.order !== 'priority' && filter.order !== 'newest') throw new RangeError('invalid semantic job order');
    if (filter.throughId !== undefined) { base.push('id <= ?'); baseParams.push(filter.throughId); }
    if (filter.statuses?.length === 0 || filter.kinds?.length === 0) return [];
    if (filter.namespace) { base.push('namespace = ?'); baseParams.push(filter.namespace); }
    if (filter.namespacePrefix !== undefined) {
      base.push("namespace LIKE ? ESCAPE '\\'");
      baseParams.push(`${filter.namespacePrefix.replace(/[\\%_]/g, '\\$&')}%`);
    }
    if (filter.generationId === null) base.push('generation_id IS NULL');
    else if (filter.generationId !== undefined) {
      if (!Number.isSafeInteger(filter.generationId) || filter.generationId < 1) throw new RangeError('invalid semantic job generationId');
      base.push('generation_id = ?'); baseParams.push(filter.generationId);
    }
    if (filter.status) { base.push('status = ?'); baseParams.push(filter.status); }
    if (filter.statuses) {
      const statuses = [...new Set(filter.statuses)];
      base.push(`status IN (${statuses.map(() => '?').join(',')})`);
      baseParams.push(...statuses);
    }
    if (filter.kinds) {
      const kinds = [...new Set(filter.kinds)];
      base.push(`kind IN (${kinds.map(() => '?').join(',')})`);
      baseParams.push(...kinds);
    }
    const newest = filter.order === 'newest';
    const order = newest ? 'ORDER BY id DESC' : filter.afterId === undefined ? 'ORDER BY priority DESC, id' : 'ORDER BY id';
    const limit = filter.limit === undefined ? '' : ` LIMIT ${Math.min(1_000, filter.limit)}`;
    const run = (where: string[], params: unknown[]): JsonJobRow[] =>
      this.db
        .prepare(`SELECT * FROM semantic_jobs${where.length ? ` WHERE ${where.join(' AND ')}` : ''}\n      ${order}${limit}`)
        .all(...params) as JsonJobRow[];

    if (!filter.namespaces) return run(base, baseParams).map(hydrateJob);

    const unique = [...new Set(filter.namespaces)];
    if (unique.length === 0) return [];
    const rows: JsonJobRow[] = [];
    for (let i = 0; i < unique.length; i += 900) {
      const chunk = unique.slice(i, i + 900);
      rows.push(...run(
        [...base, `namespace IN (${chunk.map(() => '?').join(',')})`],
        [...baseParams, ...chunk],
      ));
    }
    // Chunking loses the global ordering the single-query form guarantees.
    return rows
      .sort((a, b) => newest ? b.id - a.id : (filter.afterId === undefined ? b.priority - a.priority : 0) || (a.id - b.id))
      .slice(0, filter.limit === undefined ? undefined : Math.min(1_000, filter.limit))
      .map(hydrateJob);
  }

  getJobHighWaterId(): number {
    return (this.db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM semantic_jobs').get() as { id: number }).id;
  }

  /** Select the current project control job in SQL. Completed history must
   * never crowd an older running job out of a bounded dashboard page. */
  currentProjectJob(projectId: number, generationIds: readonly number[], pausedOnly = false): SemanticJobRow | null {
    if (!Number.isSafeInteger(projectId) || projectId <= 0 || !Array.isArray(generationIds)
      || generationIds.length > 2 || generationIds.some(id => !Number.isSafeInteger(id) || id <= 0)) {
      throw new RangeError('invalid semantic project job scope');
    }
    const marker = `semantic:reindex:code:p${projectId}`;
    const code = `code:p${projectId}`;
    const generation = generationIds.length ? `generation_id IN (${generationIds.map(() => '?').join(',')})` : 'generation_id IS NULL';
    const order = pausedOnly ? 'id DESC' : `CASE
      WHEN namespace = ? AND status IN ('pending','running','paused') THEN 0
      WHEN status IN ('pending','running','paused') THEN 1
      WHEN namespace = ? THEN 2 ELSE 3 END, id DESC`;
    const row = this.db.prepare(`SELECT id FROM semantic_jobs
      WHERE (namespace = ? OR (namespace = ? AND kind IN ('backfill','build') AND ${generation}))
      ${pausedOnly ? "AND status = 'paused'" : ''} ORDER BY ${order} LIMIT 1`)
      .get(marker, code, ...generationIds, ...(pausedOnly ? [] : [marker, marker])) as { id: number } | undefined;
    return row ? this.getJob(row.id) : null;
  }

  /** Startup needs only removal identities, never historical cursor payloads. */
  listProjectRemovalIds(): number[] {
    return (this.db.prepare(`SELECT DISTINCT namespace FROM semantic_jobs
      WHERE kind = 'cleanup' AND status NOT IN ('failed', 'cancelled')
        AND json_extract(cursor, '$.reason') = 'project-removal'`).all() as { namespace: string }[])
      .flatMap(({ namespace }) => {
        const projectId = projectIdFromRemovalNamespace(namespace);
        return projectId === null ? [] : [projectId];
      });
  }

  hasOpenNamespaceMutationJobs(namespace: string): boolean {
    return !!this.db.prepare(`SELECT 1 FROM semantic_jobs WHERE namespace = ?
      AND status IN ('pending', 'paused', 'running')
      AND (kind = 'delta' OR (kind = 'backfill' AND generation_id IS NULL)) LIMIT 1`).get(namespace);
  }

  /** True when an open namespace job represents an unbounded/unknown delta.
   * Query runtimes call this before resolving an embedding backend, so stale
   * vectors cannot trigger an ONNX model load. */
  requiresExplicitNamespaceReindex(namespace: string): boolean {
    return !!this.db.prepare(`
      SELECT 1 FROM semantic_jobs WHERE namespace = ? AND status IN ('pending', 'paused', 'running')
        AND (json_extract(cursor, '$.requires_explicit_reindex') = 1
          OR (json_extract(cursor, '$.reason') = 'code-delta'
            AND (COALESCE(json_array_length(cursor, '$.events'), 0) = 0
              OR EXISTS (SELECT 1 FROM json_each(cursor, '$.events')
                WHERE json_extract(CASE WHEN type = 'object' THEN value ELSE '{}' END, '$.path') = '*')))) LIMIT 1
    `).get(namespace);
  }

  updateJob(id: number, patch: {
    status?: SemanticJobStatus;
    cursor?: Record<string, unknown> | null;
    expected_items?: number;
    processed_items?: number;
    failed_items?: number;
    error?: string | null;
  }): SemanticJobRow | null {
    const current = this.getJob(id);
    if (!current) return null;
    const status = patch.status ?? current.status;
    const terminal = status === 'completed' || status === 'failed' || status === 'cancelled';
    this.db.prepare(`
      UPDATE semantic_jobs SET status = ?, cursor = ?, expected_items = ?, processed_items = ?, failed_items = ?,
        error = ?, started_at = CASE WHEN ? = 'running' THEN COALESCE(started_at, datetime('now')) ELSE started_at END,
        completed_at = CASE WHEN ? THEN datetime('now') ELSE completed_at END,
        updated_at = datetime('now') WHERE id = ?
    `).run(
      status,
      patch.cursor === undefined ? (current.cursor ? JSON.stringify(current.cursor) : null) : (patch.cursor ? JSON.stringify(patch.cursor) : null),
      patch.expected_items ?? current.expected_items,
      patch.processed_items ?? current.processed_items, patch.failed_items ?? current.failed_items,
      patch.error === undefined ? current.error : patch.error, status, terminal ? 1 : 0, id,
    );
    return this.getJob(id);
  }
}
