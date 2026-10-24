import {
projectMemoryNamespace
} from '@mcp/shared/vector-namespace.js';
import {
type LocalVectorRouter
} from '@mcp/store';
import { errorMessage,SemanticVectorWorkerUnavailableError,type SemanticUnusedVectorCleanupResult } from './semantic-coordinator-shared.js';

import type { SemanticCoordinatorContext } from './semantic-coordinator-context.js';

export const operations = {
cleanupUnusedVectors(this: SemanticCoordinatorContext, projectId?: number): Promise<SemanticUnusedVectorCleanupResult> {
    if (this.disposed) return Promise.reject(new Error('Semantic coordinator is shutting down'));
    const key = projectId === undefined ? 'global' : `project:${projectId}`;
    const existing = this.unusedVectorCleanupRuns.get(key);
    if (existing) return existing;
    if (this.unusedVectorCleanupRuns.size > 0) {
      return Promise.reject(new Error('another unused vector cleanup is already running'));
    }
    const running = this.performUnusedVectorCleanup(projectId).finally(() => {
      if (this.unusedVectorCleanupRuns.get(key) === running) this.unusedVectorCleanupRuns.delete(key);
    });
    this.unusedVectorCleanupRuns.set(key, running);
    return running;
  },

async performUnusedVectorCleanup(this: SemanticCoordinatorContext, projectId?: number): Promise<SemanticUnusedVectorCleanupResult> {
    const hasGeneration = this.deps.vectorStore.hasGeneration;
    const compact = this.deps.vectorStore.compactGenerationDatabase;
    if (!hasGeneration || !compact || !this.deps.vectorStore.dropGeneration) {
      throw new SemanticVectorWorkerUnavailableError('unused vector cleanup');
    }
    const executing = (await this.listJobsOffThread({
      statuses: ['running'],
      kinds: ['build', 'backfill'],
    })).some((job) =>
      // Pending rows are durable requests waiting for an explicit wake-up;
      // only running means a worker currently owns the physical database.
      job.status === 'running'
      && (job.kind === 'build' || job.kind === 'backfill')
      // Superseded jobs are historical control-plane residue, not live work.
      && this.jobGenerationIsReferenced(job)
      // A project-scoped cleanup owns only that project's vectors.db. Work in
      // another project or in a global docs/memory database must not block it.
      && (projectId === undefined || this.semanticProjectIdForJob(job) === projectId));
    if (executing) throw new Error('wait for semantic builds to finish before cleaning unused vectors');

    this.deps.semanticStore.retireUnreferencedGenerations();
    const states = this.deps.semanticStore.listNamespaceGenerations();
    const groups = new Map<string, {
      namespace: string;
      generationId: number;
      dbPath: string;
      tableName: string;
      namespaces: Set<string>;
    }>();
    for (const generation of this.deps.semanticStore.listGenerations()) {
      for (const namespace of this.deps.semanticStore.listGenerationNamespaces(generation.id)) {
        let route: ReturnType<LocalVectorRouter['resolve']>;
        try { route = this.deps.router.resolve(namespace, generation.id); }
        catch { continue; }
        if (projectId !== undefined && route.projectId !== projectId) continue;
        const key = `${route.dbPath.toLowerCase()}\0${route.tableName}`;
        const group = groups.get(key) ?? {
          namespace,
          generationId: generation.id,
          dbPath: route.dbPath,
          tableName: route.tableName,
          namespaces: new Set<string>(),
        };
        group.namespaces.add(namespace);
        groups.set(key, group);
      }
    }

    const result: SemanticUnusedVectorCleanupResult = {
      tables_removed: 0,
      items_removed: 0,
      databases_compacted: 0,
      bytes_reclaimed: 0,
      skipped_referenced: 0,
      failures: [],
    };

    // Migration 238 cannot touch worker-owned vector files. Make their old
    // `knowledge_g_*` tables visible to the existing explicit cleanup action
    // even though the retired central generations were intentionally removed.
    const dropLegacy = this.deps.vectorStore.dropLegacyKnowledgeTables;
    if (dropLegacy) {
      const legacyNamespaces = projectId === undefined
        ? [
            'docs:c0',
            'memory:user',
            ...this.deps.db.listProjects()
              .filter((project) => !project.is_synthetic)
              .map((project) => projectMemoryNamespace(project.id)),
          ]
        : [projectMemoryNamespace(projectId)];
      for (const namespace of legacyNamespaces) {
        try {
          const removed = await dropLegacy.call(this.deps.vectorStore, namespace);
          result.tables_removed += removed;
          if (removed > 0) {
            const sizes = await compact.call(this.deps.vectorStore, namespace, 1);
            result.databases_compacted += 1;
            result.bytes_reclaimed += Math.max(0, sizes.before_bytes - sizes.after_bytes);
          }
        } catch (error) {
          result.failures.push({ namespace, generation_id: 0, error: errorMessage(error) });
        }
      }
    }
    const compactTargets = new Map<string, { namespace: string; generationId: number }>();

    for (const group of groups.values()) {
      const referenced = states.some((state) => [
        state.active_generation_id,
        state.building_generation_id,
      ].filter((id): id is number => id !== null).some((generationId) => {
        try {
          const route = this.deps.router.resolve(state.namespace, generationId);
          return route.dbPath.toLowerCase() === group.dbPath.toLowerCase()
            && route.tableName === group.tableName;
        } catch {
          return true;
        }
      }));
      if (referenced) {
        result.skipped_referenced += 1;
        continue;
      }

      try {
        const exists = await hasGeneration.call(
          this.deps.vectorStore,
          group.namespace,
          group.generationId,
        );
        if (!exists) {
          for (const namespace of group.namespaces) {
            result.items_removed += this.deps.semanticStore.deleteItemsForNamespaceGeneration(
              group.generationId,
              namespace,
            );
          }
          continue;
        }
        const job = this.deps.semanticStore.createJob({
          generation_id: group.generationId,
          namespace: group.namespace,
          kind: 'cleanup',
          priority: 100,
          cursor: {
            reason: 'manual-unused-vectors',
            cleanup_namespaces: [...group.namespaces],
            db_path: group.dbPath,
            table_name: group.tableName,
          },
        });
        result.items_removed += await this.performCleanupJob(job);
        result.tables_removed += 1;
        compactTargets.set(group.dbPath.toLowerCase(), {
          namespace: group.namespace,
          generationId: group.generationId,
        });
      } catch (error) {
        result.failures.push({
          namespace: group.namespace,
          generation_id: group.generationId,
          error: errorMessage(error),
        });
      }
    }

    for (const target of compactTargets.values()) {
      try {
        const sizes = await compact.call(
          this.deps.vectorStore,
          target.namespace,
          target.generationId,
        );
        result.databases_compacted += 1;
        result.bytes_reclaimed += Math.max(0, sizes.before_bytes - sizes.after_bytes);
      } catch (error) {
        result.failures.push({
          namespace: target.namespace,
          generation_id: target.generationId,
          error: `vectors removed but database compaction failed: ${errorMessage(error)}`,
        });
      }
    }

    const referencedGenerationIds = new Set(states.flatMap((state) => [
      state.active_generation_id,
      state.building_generation_id,
    ].filter((id): id is number => id !== null)));
    for (const generation of this.deps.semanticStore.listGenerations()) {
      if (generation.status === 'building' && !referencedGenerationIds.has(generation.id)) {
        this.deps.semanticStore.updateGeneration(generation.id, {
          status: 'failed',
          error: 'unused construction generation was cleaned',
        });
      }
    }
    this.deps.semanticStore.retireUnreferencedGenerations();
    return result;
  }
};
