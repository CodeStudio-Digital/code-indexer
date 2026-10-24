import { hydrateJob } from './semantic-store-values.js';
import type { SemanticNamespaceGenerationRow, SemanticJobRow, SemanticMutationInput, CapturedSemanticMutationJob, SemanticMutationPassResult, JsonJobRow } from './semantic-store-types.js';

import type { DB } from './semantic-store-types.js';
import { SemanticMutationFences } from './semantic-mutation-fences.js';
import { SemanticJobs } from './semantic-jobs.js';
import { SemanticGenerations } from './semantic-generations.js';
export class SemanticMutations {
  constructor(private readonly db: DB, private readonly fences: SemanticMutationFences, private readonly jobs: SemanticJobs, private readonly generations: SemanticGenerations) {}

  /**
   * Durably record a relational mutation against the vector generation that
   * currently owns the namespace. The job and namespace counter are updated
   * under one IMMEDIATE transaction, so activation can never observe only one
   * side of the mutation.
   *
   * Mutations coalesce only into a job that has not been claimed. Once a
   * builder marks a job `running`, later writes get a new job and therefore a
   * distinct activation watermark.
   */
  noteNamespaceMutation(input: SemanticMutationInput): SemanticJobRow {
    const namespace = input.namespace.trim();
    if (!namespace) throw new Error('Semantic mutation namespace is required');
    const itemKeys = [...new Set(input.itemKeys.map((key) => key.trim()).filter(Boolean))];
    if (itemKeys.length === 0) itemKeys.push('*');
    const deltaCount = itemKeys.length;

    const transact = this.db.transaction((): SemanticJobRow => {
      const state = this.db.prepare(`
        SELECT * FROM semantic_namespace_generations WHERE namespace = ?
      `).get(namespace) as SemanticNamespaceGenerationRow | undefined;
      const generationId = state?.building_generation_id ?? state?.active_generation_id ?? null;

      if (input.fence) {
        const token = input.fence.token.trim();
        const owner = input.fence.owner.trim();
        if (!token || !owner) throw new Error('Semantic mutation fence token and owner are required');
        const startedAt = Date.now();
        const leaseMs = input.fence.leaseMs === undefined
          ? null
          : Math.max(1_000, Math.floor(input.fence.leaseMs));
        const sourceWatermark = itemKeys.includes('*')
          ? this.fences.memorySourceWatermark(namespace)
          : null;
        const cursor = {
          ...this.mergeMutationCursor(null, input, itemKeys, false),
          reason: 'mutation-fence',
          // A fence is one immutable caller, not a coalesced diagnostic row:
          // retain every exact key so settlement can safely narrow it.
          item_keys: itemKeys,
          item_keys_truncated: false,
          fence_phase: 'in-flight',
          fence_token: token,
          fence_owner: owner,
          fence_started_at_ms: startedAt,
          ...(sourceWatermark ? { memory_source_watermark: sourceWatermark } : {}),
          ...(leaseMs === null ? {} : { fence_lease_expires_at_ms: startedAt + leaseMs }),
        };
        const inserted = this.db.prepare(`
          INSERT INTO semantic_jobs
            (generation_id, namespace, kind, status, priority, cursor,
              expected_items, started_at)
          VALUES (?, ?, 'delta', 'running', 60, ?, ?, datetime('now'))
        `).run(generationId, namespace, JSON.stringify(cursor), deltaCount);
        if (generationId !== null) {
          this.db.prepare(`
            UPDATE semantic_namespace_generations
            SET delta_items = delta_items + ?, updated_at = datetime('now')
            WHERE namespace = ?
          `).run(deltaCount, namespace);
        }
        return this.jobs.getJob(Number(inserted.lastInsertRowid))!;
      }

      if (generationId === null) {
        const existing = this.db.prepare(`
          SELECT * FROM semantic_jobs
          WHERE namespace = ? AND generation_id IS NULL AND kind = 'backfill'
            AND status IN ('pending', 'paused')
          ORDER BY id DESC LIMIT 1
        `).get(namespace) as JsonJobRow | undefined;
        if (existing) {
          const hydrated = hydrateJob(existing);
          const cursor = this.mergeMutationCursor(hydrated.cursor, input, itemKeys);
          this.db.prepare(`
            UPDATE semantic_jobs
            SET status = 'pending', expected_items = expected_items + ?, cursor = ?,
              failed_items = 0, error = NULL, completed_at = NULL,
              updated_at = datetime('now')
            WHERE id = ?
          `).run(deltaCount, JSON.stringify(cursor), hydrated.id);
          return this.jobs.getJob(hydrated.id)!;
        }
        return this.jobs.createJob({
          generation_id: null,
          namespace,
          kind: 'backfill',
          priority: 40,
          expected_items: deltaCount,
          cursor: this.mergeMutationCursor(null, input, itemKeys),
        });
      }

      const existing = this.db.prepare(`
        SELECT * FROM semantic_jobs
        WHERE namespace = ? AND generation_id = ? AND kind = 'delta'
          AND status IN ('pending', 'paused')
        ORDER BY id DESC LIMIT 1
      `).get(namespace, generationId) as JsonJobRow | undefined;
      let job: SemanticJobRow;
      if (existing) {
        const hydrated = hydrateJob(existing);
        const cursor = this.mergeMutationCursor(hydrated.cursor, input, itemKeys);
        this.db.prepare(`
          UPDATE semantic_jobs
          SET status = 'pending', expected_items = expected_items + ?, cursor = ?,
            failed_items = 0, error = NULL, completed_at = NULL,
            updated_at = datetime('now')
          WHERE id = ?
        `).run(deltaCount, JSON.stringify(cursor), hydrated.id);
        job = this.jobs.getJob(hydrated.id)!;
      } else {
        job = this.jobs.createJob({
          generation_id: generationId,
          namespace,
          kind: 'delta',
          priority: 40,
          expected_items: deltaCount,
          cursor: this.mergeMutationCursor(null, input, itemKeys),
        });
      }
      this.db.prepare(`
        UPDATE semantic_namespace_generations
        SET delta_items = delta_items + ?, updated_at = datetime('now')
        WHERE namespace = ?
      `).run(deltaCount, namespace);
      return job;
    });
    return transact.immediate();
  }

  /**
   * Commit one full documentation/snapshot/memory reconciliation pass.
   * Captured jobs are acknowledged, but any job that arrived after the
   * watermark remains open and keeps the building generation non-serving.
   * Progress, acknowledgements
   * and the optional namespace switch share one IMMEDIATE transaction.
   */
  finishNamespaceMutationPass(input: {
    namespace: string;
    generation_id: number;
    expected_items: number;
    indexed_items: number;
    captured_jobs: readonly CapturedSemanticMutationJob[];
    activate: boolean;
  }): SemanticMutationPassResult {
    const transact = this.db.transaction((): SemanticMutationPassResult => {
      const state = this.db.prepare(`
        SELECT * FROM semantic_namespace_generations WHERE namespace = ?
      `).get(input.namespace) as SemanticNamespaceGenerationRow | undefined;
      if (!state) throw new Error(`Semantic namespace not found: ${input.namespace}`);
      if (input.activate) {
        if (state.building_generation_id !== input.generation_id) {
          throw new Error(`Generation ${input.generation_id} is not building for ${input.namespace}`);
        }
      } else if (state.active_generation_id !== input.generation_id) {
        throw new Error(`Generation ${input.generation_id} is not active for ${input.namespace}`);
      }
      if (input.indexed_items < input.expected_items) {
        throw new Error(
          `vector coverage incomplete: ${input.indexed_items}/${input.expected_items} items`,
        );
      }

      const captured = new Map(input.captured_jobs.map((job) => [job.id, job.expected_items]));
      const openRows = this.db.prepare(`
        SELECT * FROM semantic_jobs
        WHERE namespace = ? AND status IN ('pending', 'running', 'paused')
          AND (kind = 'delta' OR (kind = 'backfill' AND generation_id IS NULL))
        ORDER BY id
      `).all(input.namespace) as JsonJobRow[];
      const open = openRows.map(hydrateJob);
      const acknowledged = open.filter((job) =>
        captured.get(job.id) === job.expected_items
        && !(job.cursor?.reason === 'mutation-fence'
          && job.cursor?.fence_phase === 'in-flight'));
      const acknowledgedIds = new Set(acknowledged.map((job) => job.id));
      const pending = acknowledgedIds.size !== captured.size
        || open.some((job) => !acknowledgedIds.has(job.id));
      const drainedDelta = acknowledged
        .filter((job) => job.kind === 'delta')
        .reduce((sum, job) => sum + job.expected_items, 0);
      const remainingDelta = Math.max(0, state.delta_items - drainedDelta);

      for (const job of acknowledged) {
        this.db.prepare(`
          UPDATE semantic_jobs
          SET status = 'completed', processed_items = expected_items,
            failed_items = 0, error = NULL, completed_at = datetime('now'),
            updated_at = datetime('now')
          WHERE id = ?
        `).run(job.id);
      }

      this.db.prepare(`
        UPDATE semantic_namespace_generations
        SET expected_items = ?, indexed_items = ?, failed_items = 0,
          delta_items = ?, last_error = NULL, updated_at = datetime('now')
        WHERE namespace = ?
      `).run(
        input.expected_items,
        input.indexed_items,
        remainingDelta,
        input.namespace,
      );

      const hasPending = pending || remainingDelta > 0;
      let activated = false;
      if (!hasPending && input.activate) {
        const generation = this.generations.getGeneration(input.generation_id);
        if (!generation || (generation.status !== 'building' && generation.status !== 'ready')) {
          throw new Error(`Generation ${input.generation_id} is not activatable`);
        }
        const switched = this.db.prepare(`
          UPDATE semantic_namespace_generations
          SET active_generation_id = ?, building_generation_id = NULL,
            last_error = NULL, updated_at = datetime('now')
          WHERE namespace = ? AND building_generation_id = ? AND delta_items = 0
        `).run(input.generation_id, input.namespace, input.generation_id);
        if (switched.changes !== 1) {
          throw new Error(`Generation ${input.generation_id} lost the activation race for ${input.namespace}`);
        }
        activated = true;
      }

      return {
        state: this.db.prepare(`
          SELECT * FROM semantic_namespace_generations WHERE namespace = ?
        `).get(input.namespace) as SemanticNamespaceGenerationRow,
        pending: hasPending,
        activated,
        completed_job_ids: [...acknowledgedIds],
      };
    });
    return transact.immediate();
  }

  private mergeMutationCursor(
    cursor: Record<string, unknown> | null,
    input: SemanticMutationInput,
    itemKeys: readonly string[],
    boundKeys = true,
  ): Record<string, unknown> {
    const previousKeys = Array.isArray(cursor?.item_keys)
      ? cursor.item_keys.filter((value): value is string => typeof value === 'string')
      : [];
    // Cursor details are diagnostic only; bound them so a hot namespace does
    // not turn job coalescing into an ever-growing JSON document.
    const allKeys = [...new Set([...previousKeys, ...itemKeys])];
    const truncated = cursor?.item_keys_truncated === true || (boundKeys && allKeys.length > 256);
    const mergedKeys = boundKeys ? allKeys.slice(-256) : allKeys;
    const requiresExplicitReindex = cursor?.requires_explicit_reindex === true
      || input.requiresExplicitReindex === true;
    return {
      ...(cursor ?? {}),
      reason: 'relational-mutation',
      operation: input.operation,
      item_keys: mergedKeys,
      ...(truncated ? { item_keys_truncated: true } : {}),
      mutation_count: Math.max(0, Number(cursor?.mutation_count) || 0) + itemKeys.length,
      ...(requiresExplicitReindex ? { requires_explicit_reindex: true } : {}),
    };
  }
}
