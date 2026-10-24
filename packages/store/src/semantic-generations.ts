import { hydrateGeneration } from './semantic-store-values.js';
import type { SemanticPurpose, EmbeddingTarget, SemanticGenerationStatus, SemanticGenerationRow, SemanticNamespaceGenerationRow, JsonGenerationRow } from './semantic-store-types.js';

import type { DB } from './semantic-store-types.js';

export class SemanticGenerations {
  constructor(private readonly db: DB) {}

  listGenerations(filter: { purpose?: SemanticPurpose; status?: SemanticGenerationStatus } = {}): SemanticGenerationRow[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.purpose) { where.push('purpose = ?'); params.push(filter.purpose); }
    if (filter.status) { where.push('status = ?'); params.push(filter.status); }
    const sql = `SELECT * FROM semantic_generations${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC`;
    return (this.db.prepare(sql).all(...params) as JsonGenerationRow[]).map(hydrateGeneration);
  }

  getGeneration(id: number): SemanticGenerationRow | null {
    const row = this.db.prepare(`SELECT * FROM semantic_generations WHERE id = ?`).get(id) as
      | JsonGenerationRow
      | undefined;
    return row ? hydrateGeneration(row) : null;
  }

  /**
   * Resolve the immutable embedding snapshot currently serving one namespace.
   * `semantic_profiles` is only the desired configuration for the next build;
   * query-time code must never read it to embed against already-stored vectors.
   */
  getActiveGeneration(namespace: string): SemanticGenerationRow | null {
    const row = this.db.prepare(`
      SELECT generation.*
      FROM semantic_namespace_generations AS namespace
      JOIN semantic_generations AS generation
        ON generation.id = namespace.active_generation_id
      WHERE namespace.namespace = ?
    `).get(namespace) as JsonGenerationRow | undefined;
    return row ? hydrateGeneration(row) : null;
  }

  /** Resolve the immutable generation currently accepting writes for one
   * namespace. A replacement under construction takes precedence over the
   * active generation, matching LocalVectorRouter's write policy. */
  getWriteGeneration(namespace: string): SemanticGenerationRow | null {
    const row = this.db.prepare(`
      SELECT generation.*
      FROM semantic_namespace_generations AS namespace
      JOIN semantic_generations AS generation
        ON generation.id = COALESCE(
          namespace.building_generation_id,
          namespace.active_generation_id
        )
      WHERE namespace.namespace = ?
    `).get(namespace) as JsonGenerationRow | undefined;
    return row ? hydrateGeneration(row) : null;
  }

  createGeneration(input: {
    purpose: SemanticPurpose;
    fingerprint: string;
    embedding_target: EmbeddingTarget;
    dimension: number;
    expected_items?: number;
  }): SemanticGenerationRow {
    const info = this.db.prepare(`
      INSERT INTO semantic_generations
        (purpose, fingerprint, embedding_target, dimension, expected_items, status, started_at)
      VALUES (?, ?, ?, ?, ?, 'building', datetime('now'))
    `).run(
      input.purpose, input.fingerprint, JSON.stringify(input.embedding_target),
      input.dimension, input.expected_items ?? 0,
    );
    const row = this.db.prepare(`SELECT * FROM semantic_generations WHERE id = ?`)
      .get(Number(info.lastInsertRowid)) as JsonGenerationRow;
    return hydrateGeneration(row);
  }

  updateGeneration(id: number, patch: {
    status?: SemanticGenerationStatus;
    expected_items?: number;
    indexed_items?: number;
    failed_items?: number;
    error?: string | null;
  }): SemanticGenerationRow | null {
    const current = this.getGeneration(id);
    if (!current) return null;
    const status = patch.status ?? current.status;
    const completed = status === 'ready' || status === 'failed' || status === 'retired';
    this.db.prepare(`
      UPDATE semantic_generations SET status = ?, expected_items = ?, indexed_items = ?,
        failed_items = ?, error = ?, completed_at = CASE
          WHEN ? = 'building' THEN NULL
          WHEN ? THEN datetime('now')
          ELSE completed_at
        END
      WHERE id = ?
    `).run(
      status, patch.expected_items ?? current.expected_items, patch.indexed_items ?? current.indexed_items,
      patch.failed_items ?? current.failed_items, patch.error === undefined ? current.error : patch.error,
      status, completed ? 1 : 0, id,
    );
    return this.getGeneration(id);
  }

  listNamespaceGenerations(filter: { purpose?: SemanticPurpose; namespace?: string } = {}): SemanticNamespaceGenerationRow[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.purpose) { where.push('purpose = ?'); params.push(filter.purpose); }
    if (filter.namespace) { where.push('namespace = ?'); params.push(filter.namespace); }
    const sql = `SELECT * FROM semantic_namespace_generations${where.length ? ` WHERE ${where.join(' AND ')}` : ''}
      ORDER BY namespace`;
    return this.db.prepare(sql).all(...params) as SemanticNamespaceGenerationRow[];
  }

  beginNamespaceGeneration(input: {
    namespace: string;
    purpose: SemanticPurpose;
    generation_id: number;
    expected_items?: number;
  }): SemanticNamespaceGenerationRow {
    const generation = this.getGeneration(input.generation_id);
    if (!generation || generation.purpose !== input.purpose) {
      throw new Error(`Generation ${input.generation_id} does not belong to ${input.purpose}`);
    }
    this.db.prepare(`
      INSERT INTO semantic_namespace_generations
        (namespace, purpose, building_generation_id, expected_items)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(namespace) DO UPDATE SET
        purpose = excluded.purpose, building_generation_id = excluded.building_generation_id,
        expected_items = excluded.expected_items, indexed_items = 0, failed_items = 0,
        delta_items = 0, last_error = NULL, updated_at = datetime('now')
    `).run(input.namespace, input.purpose, input.generation_id, input.expected_items ?? 0);
    return this.listNamespaceGenerations({ namespace: input.namespace })[0];
  }

  updateNamespaceProgress(namespace: string, patch: {
    expected_items?: number;
    indexed_items?: number;
    failed_items?: number;
    delta_items?: number;
    last_error?: string | null;
  }): SemanticNamespaceGenerationRow | null {
    const current = this.listNamespaceGenerations({ namespace })[0];
    if (!current) return null;
    this.db.prepare(`
      UPDATE semantic_namespace_generations SET expected_items = ?, indexed_items = ?,
        failed_items = ?, delta_items = ?, last_error = ?, updated_at = datetime('now')
      WHERE namespace = ?
    `).run(
      patch.expected_items ?? current.expected_items, patch.indexed_items ?? current.indexed_items,
      patch.failed_items ?? current.failed_items, patch.delta_items ?? current.delta_items,
      patch.last_error === undefined ? current.last_error : patch.last_error, namespace,
    );
    return this.listNamespaceGenerations({ namespace })[0];
  }

  /** Clear an abandoned construction pointer only when it still references
   * the generation that was physically dropped. The compare-and-clear keeps
   * a concurrent replacement from being detached accidentally. */
  clearBuildingGeneration(
    namespace: string,
    generationId: number,
    lastError: string | null = null,
  ): SemanticNamespaceGenerationRow | null {
    this.db.prepare(`
      UPDATE semantic_namespace_generations
      SET building_generation_id = NULL, delta_items = 0, last_error = ?,
        updated_at = datetime('now')
      WHERE namespace = ? AND building_generation_id = ?
    `).run(lastError, namespace, generationId);
    return this.listNamespaceGenerations({ namespace })[0] ?? null;
  }

  /** Atomically switch a namespace only after its complete, error-free build. */
  activateNamespaceGeneration(namespace: string, generationId: number): SemanticNamespaceGenerationRow {
    return this.db.transaction(() => {
      const state = this.listNamespaceGenerations({ namespace })[0];
      const generation = this.getGeneration(generationId);
      if (!state || state.building_generation_id !== generationId) {
        throw new Error(`Generation ${generationId} is not building for ${namespace}`);
      }
      // A generation rolls out atomically per namespace, so it can already
      // serve completed namespaces while the global rollout is still marked
      // building. The coordinator marks it ready only after every target
      // namespace has completed its logical + physical coverage gate.
      if (!generation || (generation.status !== 'building' && generation.status !== 'ready')) {
        throw new Error(`Generation ${generationId} is not activatable`);
      }
      if (state.failed_items > 0 || state.delta_items > 0 || state.indexed_items < state.expected_items) {
        throw new Error(`Namespace ${namespace} is incomplete`);
      }
      this.db.prepare(`
        UPDATE semantic_namespace_generations SET active_generation_id = ?,
          building_generation_id = NULL, last_error = NULL, updated_at = datetime('now')
        WHERE namespace = ?
      `).run(generationId, namespace);
      return this.listNamespaceGenerations({ namespace })[0];
    })();
  }

  retireUnreferencedGenerations(purpose?: SemanticPurpose): number {
    const result = this.db.prepare(`
      UPDATE semantic_generations SET status = 'retired', completed_at = COALESCE(completed_at, datetime('now'))
      WHERE status = 'ready' ${purpose ? 'AND purpose = ?' : ''}
        AND id NOT IN (
          SELECT active_generation_id FROM semantic_namespace_generations WHERE active_generation_id IS NOT NULL
          UNION SELECT building_generation_id FROM semantic_namespace_generations WHERE building_generation_id IS NOT NULL
        )
    `).run(...(purpose ? [purpose] : []));
    return result.changes;
  }

  /** Historical namespaces are the routing evidence needed to locate an old
   * generation table after active/building pointers have moved on. */
  listGenerationNamespaces(generationId: number): string[] {
    const rows = this.db.prepare(`
      SELECT namespace FROM semantic_items WHERE generation_id = ?
      UNION
      SELECT namespace FROM semantic_jobs WHERE generation_id = ?
      ORDER BY namespace
    `).all(generationId, generationId) as Array<{ namespace: string }>;
    return rows.map((row) => row.namespace);
  }

  deleteNamespace(namespace: string): { items: number; jobs: number; namespace: number } {
    return this.db.transaction(() => {
      const state = this.listNamespaceGenerations({ namespace })[0];
      const jobs = this.db.prepare(`DELETE FROM semantic_jobs WHERE namespace = ?`).run(namespace).changes;
      const items = this.db.prepare(`DELETE FROM semantic_items WHERE namespace = ?`).run(namespace).changes;
      const removed = this.db.prepare(`DELETE FROM semantic_namespace_generations WHERE namespace = ?`).run(namespace).changes;
      for (const id of [state?.active_generation_id, state?.building_generation_id]) {
        if (!id) continue;
        this.db.prepare(`
          UPDATE semantic_generations SET status = 'retired', completed_at = COALESCE(completed_at, datetime('now'))
          WHERE id = ? AND status IN ('building', 'ready')
            AND NOT EXISTS (
              SELECT 1 FROM semantic_namespace_generations
              WHERE active_generation_id = ? OR building_generation_id = ?
            )
        `).run(id, id, id);
      }
      return { items, jobs, namespace: removed };
    })();
  }
}
