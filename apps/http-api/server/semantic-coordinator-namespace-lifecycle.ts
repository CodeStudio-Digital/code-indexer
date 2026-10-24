import {
type LocalVectorRouter
} from '@mcp/store';
import { errorMessage } from './semantic-coordinator-shared.js';
import { nextSemanticRetry } from './semantic-retry-policy.js';

import type { SemanticCoordinatorContext } from './semantic-coordinator-context.js';

export const operations = {
async completeNamespace(this: SemanticCoordinatorContext,
    namespace: string,
    generationId: number,
    jobId: number,
    indexed: number,
    expected: number,
    previousActiveGenerationId: number | null,
  ): Promise<void> {
    // A missing/failed vector write must never be hidden by reducing the
    // expected count to whatever happened to land. Empty source scopes are
    // valid; non-empty scopes require full coverage.
    if (indexed < expected) {
      throw new Error(`vector coverage incomplete: ${indexed}/${expected} items`);
    }
    this.deps.semanticStore.updateNamespaceProgress(namespace, {
      expected_items: expected, indexed_items: expected, failed_items: 0, last_error: null,
    });
    this.deps.semanticStore.activateNamespaceGeneration(namespace, generationId);
    this.deps.semanticStore.updateJob(jobId, {
      status: 'completed', processed_items: expected, failed_items: 0, error: null,
    });
    await this.cleanupGenerationIfUnreferenced(namespace, previousActiveGenerationId);
  },

async cleanupGenerationIfUnreferenced(this: SemanticCoordinatorContext,
    namespace: string,
    generationId: number | null,
  ): Promise<void> {
    if (!generationId) return;
    let target: ReturnType<LocalVectorRouter['resolve']>;
    try {
      target = this.deps.router.resolve(namespace, generationId);
    } catch {
      return;
    }
    const key = `${target.dbPath.toLowerCase()}\0${target.tableName}`;
    const running = this.cleanupRuns.get(key);
    if (running) return running;

    const cleanup = (async (): Promise<void> => {
      const referenced = this.deps.semanticStore.listNamespaceGenerations({ purpose: target.purpose })
        .some((row) => {
          if (row.active_generation_id !== generationId && row.building_generation_id !== generationId) return false;
          try {
            const route = this.deps.router.resolve(row.namespace, generationId);
            return route.dbPath.toLowerCase() === target.dbPath.toLowerCase()
              && route.tableName === target.tableName;
          } catch {
            // An unresolved namespace is conservatively considered a
            // reference: never delete a table we cannot prove is orphaned.
            return true;
          }
        });
      if (referenced) return;

      const job = this.deps.semanticStore.createJob({
        generation_id: generationId,
        namespace,
        kind: 'cleanup',
        priority: -10,
        cursor: {
          reason: 'unreferenced',
          cleanup_namespaces: this.deps.semanticStore.listGenerationNamespaces(generationId)
            .filter((candidateNamespace) => {
              try {
                const route = this.deps.router.resolve(candidateNamespace, generationId);
                return route.dbPath.toLowerCase() === target.dbPath.toLowerCase()
                  && route.tableName === target.tableName;
              } catch {
                return false;
              }
            }),
          db_path: target.dbPath,
          table_name: target.tableName,
        },
      });
      try {
        await this.performCleanupJob(job);
      } catch (error) {
        const message = errorMessage(error);
        console.warn(`[semantic] generation cleanup paused for ${namespace} g${generationId}: ${message}`);
      }
    })();
    const tracked = cleanup.finally(() => {
      if (this.cleanupRuns.get(key) === tracked) this.cleanupRuns.delete(key);
    });
    this.cleanupRuns.set(key, tracked);
    return tracked;
  },

pauseNamespace(this: SemanticCoordinatorContext, namespace: string, jobId: number, error: unknown): void {
    const message = errorMessage(error);
    const job = this.deps.semanticStore.getJob(jobId);
    const previous = job?.cursor?.retry as { attempt?: number } | undefined;
    const retry = nextSemanticRetry(error, previous?.attempt);
    this.deps.semanticStore.updateNamespaceProgress(namespace, { failed_items: 1, last_error: message });
    this.deps.semanticStore.updateJob(jobId, {
      status: 'paused', failed_items: 1, error: message, cursor: { ...job?.cursor, retry },
    });
  },

refreshGenerationProgress(this: SemanticCoordinatorContext, generationId: number): void {
    const generation = this.deps.semanticStore.getGeneration(generationId);
    if (!generation) return;
    const rows = this.deps.semanticStore.listNamespaceGenerations().filter((row) =>
      (row.active_generation_id === generationId || row.building_generation_id === generationId)
      && this.allowsNamespaceMutation(row.namespace));
    // Generations are reusable vector spaces, not global rollout mandates.
    // On-demand indexing may legitimately target one project/collection; only
    // namespaces that reference this generation participate in its readiness.
    const complete = rows.length > 0 && rows.every((row) => {
      return row
        && row.active_generation_id === generationId
        && row.building_generation_id === null
        && row.failed_items === 0
        && row.delta_items === 0
        && row.indexed_items >= row.expected_items;
    });
    const failedItems = rows.reduce((sum, row) => sum + row.failed_items, 0);
    this.deps.semanticStore.updateGeneration(generationId, {
      expected_items: rows.reduce((sum, row) => sum + row.expected_items, 0),
      indexed_items: rows.reduce((sum, row) => sum + row.indexed_items, 0),
      failed_items: failedItems,
      status: complete ? 'ready' : 'building',
      error: complete ? null : rows.find((row) => row.last_error)?.last_error ?? null,
    });
  },

serial(this: SemanticCoordinatorContext,
    namespace: string,
    operation: () => Promise<void>,
    allowProjectRemoval = false,
  ): Promise<void> {
    const previous = this.locks.get(namespace) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(async () => {
      if (!allowProjectRemoval && !this.allowsNamespaceMutation(namespace)) return;
      await operation();
    });
    const tracked = current.finally(() => {
      if (this.locks.get(namespace) === tracked) this.locks.delete(namespace);
    });
    this.locks.set(namespace, tracked);
    return tracked;
  }
};
