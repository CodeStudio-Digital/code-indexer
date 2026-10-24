import {
agentMemoryEmbeddingTextHash,
agentMemoryEmbeddingTexts
} from '@mcp/services/memory/agent-memory-service.js';
import {
investigationEmbeddingTextHash
} from '@mcp/services/memory/investigation-semantic-index.js';
import {
type SemanticGenerationRow,
type SemanticJobRow
} from '@mcp/store';
import {
embeddingFingerprintForGeneration
} from '@mcp/store/vectors.js';

import type { SemanticCoordinatorContext } from './semantic-coordinator-context.js';

export const operations = {
async reconcileTargetedMemoryMutation(this: SemanticCoordinatorContext,
    scope: 'project' | 'user',
    projectId: number,
    generation: SemanticGenerationRow,
    namespace: string,
    itemKeys: readonly string[],
  ): Promise<{ namespaceItems: number; processedKeys: number }> {
    const beforeState = this.deps.semanticStore.listNamespaceGenerations({ namespace })[0];
    if (beforeState?.active_generation_id !== generation.id) {
      throw new Error(`Targeted Memory delta lost the active generation for ${namespace}`);
    }
    const beforeItems = this.deps.semanticStore.listItems({
      generation_id: generation.id,
      namespace,
      item_keys: itemKeys,
    });
    const beforeVectorIds = new Set(beforeItems.flatMap((item) =>
      item.vector_id ? [item.vector_id] : []));
    const fingerprint = embeddingFingerprintForGeneration(generation.fingerprint);
    const expected = new Map<string, string>();
    const deleteKeys: string[] = [];
    const investigationById = scope === 'project'
      && itemKeys.some((itemKey) => itemKey.startsWith('investigation:'))
      ? new Map((await this.deps.investigationSemanticIndex.listProject(projectId))
        .map((row) => [row.id, row]))
      : new Map<string, never>();

    for (const itemKey of itemKeys) {
      const memoryMatch = /^agent_memory:(\d+)$/.exec(itemKey);
      if (memoryMatch) {
        const row = this.deps.db.getAgentMemoryById(Number(memoryMatch[1]));
        const live = row
          && row.archived_at == null
          && (scope === 'user'
            ? row.scope === 'user' && row.project_id === 0
            : (row.scope === 'project' || row.scope === 'local')
              && row.project_id === projectId);
        if (!live) {
          deleteKeys.push(itemKey);
          continue;
        }
        const result = await this.deps.agentMemoryService.embedAndUpsert(row);
        if (!result.ok) {
          throw new Error(`memory embedding failed for ${itemKey}: ${result.error ?? 'unknown error'}`);
        }
        const hash = agentMemoryEmbeddingTextHash(row, fingerprint);
        for (let index = 0; index < agentMemoryEmbeddingTexts(row).length; index++) {
          expected.set(`${itemKey}\0${index}`, hash);
        }
        continue;
      }

      const investigationMatch = /^investigation:(.+)$/.exec(itemKey);
      const investigation = investigationMatch
        ? investigationById.get(investigationMatch[1])
        : undefined;
      if (!investigation) {
        deleteKeys.push(itemKey);
        continue;
      }
      const result = await this.deps.investigationSemanticIndex.embedAndUpsert(investigation);
      if (!result.ok) {
        throw new Error(`investigation embedding failed for ${itemKey}: ${result.error ?? 'unknown error'}`);
      }
      expected.set(
        `${itemKey}\0${0}`,
        investigationEmbeddingTextHash(investigation, fingerprint),
      );
    }

    if (deleteKeys.length > 0) {
      await this.workerDeleteItemKeys(namespace, generation.id, deleteKeys);
    }
    const afterItems = this.deps.semanticStore.listItems({
      generation_id: generation.id,
      namespace,
      item_keys: itemKeys,
    });
    const actual = new Map(afterItems.map((item) => [
      `${item.item_key}\0${item.chunk_index}`,
      item,
    ]));
    if (actual.size !== afterItems.length || actual.size !== expected.size) {
      throw new Error(
        `targeted memory coverage incomplete: found ${actual.size}/${expected.size} exact items`,
      );
    }
    for (const [identity, hash] of expected) {
      const item = actual.get(identity);
      if (!item || item.status !== 'indexed' || !item.vector_id || item.source_hash !== hash) {
        throw new Error(
          `targeted memory coverage incomplete: ${identity.replace('\0', '#')} is not current`,
        );
      }
    }
    const afterVectorIds = new Set(afterItems.flatMap((item) =>
      item.vector_id ? [item.vector_id] : []));
    const physicalIds = new Set(await this.workerListIds(namespace, generation.id));
    for (const vectorId of afterVectorIds) {
      if (!physicalIds.has(vectorId)) {
        throw new Error(`targeted memory physical coverage incomplete: ${vectorId} is missing`);
      }
    }
    for (const vectorId of beforeVectorIds) {
      if (!afterVectorIds.has(vectorId) && physicalIds.has(vectorId)) {
        throw new Error(`targeted memory physical cleanup incomplete: ${vectorId} is stale`);
      }
    }

    const namespaceItems = Math.max(
      0,
      (beforeState?.indexed_items ?? 0) - beforeItems.length + afterItems.length,
    );
    return { namespaceItems, processedKeys: itemKeys.length };
  },

captureDocsMutationJobs(this: SemanticCoordinatorContext, namespace: string): SemanticJobRow[] {
    const relevant = (job: SemanticJobRow): boolean =>
      job.namespace === namespace
      && (job.kind === 'delta' || (job.kind === 'backfill' && job.generation_id === null))
      && (job.status === 'pending' || job.status === 'paused' || job.status === 'running');
    const isLiveFence = (job: SemanticJobRow): boolean =>
      job.status === 'running'
      && job.cursor?.reason === 'mutation-fence'
      && job.cursor?.fence_phase === 'in-flight';

    for (const job of this.deps.semanticStore.listJobs({ namespace, statuses: ['pending', 'paused', 'running'], kinds: ['delta', 'backfill'] }).filter(relevant)) {
      if (isLiveFence(job) || job.status !== 'running') continue;
      // A non-fence running delta/backfill was interrupted before it could
      // commit its watermark. Return it to pending before claiming this pass.
      this.deps.semanticStore.updateJob(job.id, {
        status: 'pending', processed_items: 0, failed_items: 0, error: null,
      });
    }
    const captured = this.deps.semanticStore.listJobs({ namespace, statuses: ['pending', 'paused', 'running'], kinds: ['delta', 'backfill'] })
      .filter((job) => relevant(job) && !isLiveFence(job));
    for (const job of captured) {
      this.deps.semanticStore.updateJob(job.id, {
        status: 'running', processed_items: 0, failed_items: 0, error: null,
      });
    }
    return captured.map((job) => this.deps.semanticStore.getJob(job.id) ?? job);
  },

hasOpenDocsMutationJobs(this: SemanticCoordinatorContext, namespace: string): boolean {
    return this.deps.semanticStore.hasOpenNamespaceMutationJobs(namespace);
  },

hasLiveDocsMutationFence(this: SemanticCoordinatorContext, namespace: string): boolean {
    return this.deps.semanticStore.hasLiveMutationFence(namespace);
  },

captureMemoryMutationJobs(this: SemanticCoordinatorContext, namespace: string): SemanticJobRow[] {
    const relevant = (job: SemanticJobRow): boolean =>
      job.namespace === namespace
      && (job.kind === 'delta' || (job.kind === 'backfill' && job.generation_id === null))
      && (job.status === 'pending' || job.status === 'paused' || job.status === 'running');
    const isLiveFence = (job: SemanticJobRow): boolean =>
      job.kind === 'delta'
      && job.status === 'running'
      && job.cursor?.reason === 'mutation-fence'
      && job.cursor?.fence_phase === 'in-flight';
    for (const job of this.deps.semanticStore.listJobs({ namespace, statuses: ['pending', 'paused', 'running'], kinds: ['delta', 'backfill'] }).filter(relevant)) {
      if (job.status !== 'running') continue;
      if (isLiveFence(job)) continue;
      this.deps.semanticStore.updateJob(job.id, {
        status: 'pending', processed_items: 0, failed_items: 0, error: null,
      });
    }
    const captured = this.deps.semanticStore.listJobs({ namespace, statuses: ['pending', 'paused', 'running'], kinds: ['delta', 'backfill'] })
      .filter((job) => relevant(job) && !isLiveFence(job));
    for (const job of captured) {
      this.deps.semanticStore.updateJob(job.id, {
        status: 'running', processed_items: 0, failed_items: 0, error: null,
      });
    }
    return captured.map((job) => this.deps.semanticStore.getJob(job.id) ?? job);
  },

hasLiveMemoryMutationFence(this: SemanticCoordinatorContext, namespace: string): boolean {
    return this.deps.semanticStore.hasLiveMutationFence(namespace);
  }
};
