import {
buildEmbeddingText,
hashEmbeddingInput
} from '@mcp/services/services/docs/index.js';
import {
docNamespace
} from '@mcp/shared/vector-namespace.js';
import {
type SemanticGenerationRow
} from '@mcp/store';
import { DeltaBuildPendingError,errorMessage } from './semantic-coordinator-shared.js';

import type { SemanticCoordinatorContext } from './semantic-coordinator-context.js';

export const operations = {
async buildDocsNamespace(this: SemanticCoordinatorContext, collectionId: number, generation: SemanticGenerationRow, force: boolean): Promise<void> {
    const namespace = docNamespace(collectionId);
    for (let pass = 0; pass < 3; pass++) {
      const before = this.deps.semanticStore.listNamespaceGenerations({ namespace })[0];
      // Relational ingestion can be long-running. Its pre-mutation fence is
      // already sufficient to keep the old generation serving, so avoid
      // repeating expensive full backfills until the caller settles it.
      if (this.hasLiveDocsMutationFence(namespace)) {
        throw new DeltaBuildPendingError(namespace);
      }
      const captured = this.captureDocsMutationJobs(namespace);
      const hasOpenMutation = this.hasOpenDocsMutationJobs(namespace);
      if (!force
        && before?.active_generation_id === generation.id
        && before.delta_items === 0
        && captured.length === 0
        && !hasOpenMutation) return;
      const total = this.deps.docStore.countChunksByCollection(collectionId);
      const activating = before?.active_generation_id !== generation.id;
      if (activating) {
        this.prepareNamespaceGeneration(namespace, 'docs', generation.id, total);
      }
      const job = this.deps.semanticStore.getOrCreateBuildJob({
        generation_id: generation.id,
        namespace,
        // Mutation fences are the delta watermark. Keep this execution job
        // out of finishNamespaceMutationPass' open-delta query.
        kind: before?.active_generation_id ? 'build' : 'backfill',
        expected_items: total,
        priority: 20,
      });
      this.deps.semanticStore.updateJob(job.id, { status: 'running' });
      try {
        const result = await this.deps.docsIndexer.retryEmbeddingsUnlocked({ collectionId, force }, {
          onProgress: ({ current }) => {
            this.deps.semanticStore.updateJob(job.id, { processed_items: current });
            this.deps.semanticStore.updateNamespaceProgress(namespace, { indexed_items: current });
          },
        });
        if (result.stopped || result.embedded < result.total) {
          throw new Error(result.stopped ? `embedding ${result.stopped}` : `embedded ${result.embedded}/${result.total}`);
        }
        const indexed = await this.verifyDocsVectorCoverage(collectionId, generation.id, namespace);
        const finish = this.deps.semanticStore.finishNamespaceMutationPass({
          namespace,
          generation_id: generation.id,
          expected_items: indexed,
          indexed_items: indexed,
          captured_jobs: captured.map((delta) => ({ id: delta.id, expected_items: delta.expected_items })),
          activate: activating,
        });
        this.deps.semanticStore.updateJob(job.id, {
          status: 'completed', processed_items: indexed, failed_items: 0, error: null,
        });
        if (finish.pending) {
          if (pass < 2) continue;
          throw new DeltaBuildPendingError(namespace);
        }
        if (finish.activated) {
          await this.cleanupGenerationIfUnreferenced(namespace, before?.active_generation_id ?? null);
        }
        return;
      } catch (error) {
        if (error instanceof DeltaBuildPendingError) throw error;
        const message = errorMessage(error);
        for (const delta of captured) {
          const current = this.deps.semanticStore.getJob(delta.id);
          if (current && current.status !== 'completed') {
            this.deps.semanticStore.updateJob(delta.id, { status: 'paused', error: message });
          }
        }
        this.pauseNamespace(namespace, job.id, error);
        throw error;
      }
    }
  },

async verifyDocsVectorCoverage(this: SemanticCoordinatorContext,
    collectionId: number,
    generationId: number,
    namespace: string,
  ): Promise<number> {
    const chunks = this.deps.docStore.listChunksByCollection(collectionId);
    const expected = new Map(chunks.map((chunk) => [
      `doc_chunk:${chunk.id}\0${0}`,
      {
        hash: hashEmbeddingInput(buildEmbeddingText(
          chunk.heading_path,
          null,
          chunk.content,
          chunk.api_signature,
        )),
        vectorId: `doc_chunk:${chunk.id}`,
      },
    ]));
    let items = this.deps.semanticStore.listItems({ generation_id: generationId, namespace });
    const expectedIdentities = new Set(expected.keys());
    const expectedItemKeys = new Set(Array.from(expectedIdentities, (identity) => identity.split('\0', 1)[0]));
    const obsoleteKeys = [...new Set(items
      .filter((item) => !expectedItemKeys.has(item.item_key))
      .map((item) => item.item_key))];
    if (obsoleteKeys.length > 0) {
      await this.workerDeleteItemKeys(namespace, generationId, obsoleteKeys);
    }
    const obsoleteIds = items.flatMap((item) =>
      item.vector_id
      && expectedItemKeys.has(item.item_key)
      && !expectedIdentities.has(`${item.item_key}\0${item.chunk_index}`)
        ? [item.vector_id]
        : []);
    if (obsoleteIds.length > 0) {
      await this.workerDeleteIds(namespace, generationId, obsoleteIds);
    }
    if (obsoleteKeys.length > 0 || obsoleteIds.length > 0) {
      items = this.deps.semanticStore.listItems({ generation_id: generationId, namespace });
    }
    const actual = new Map(items.map((item) => [`${item.item_key}\0${item.chunk_index}`, item]));
    if (actual.size !== items.length) {
      throw new Error('docs vector coverage incomplete: duplicate semantic item');
    }
    for (const [identity, source] of expected) {
      const item = actual.get(identity);
      if (!item
        || item.status !== 'indexed'
        || item.vector_id !== source.vectorId
        || item.source_hash !== source.hash) {
        throw new Error(`docs vector coverage incomplete: ${identity.replace('\0', '#')} is not current`);
      }
    }
    if (actual.size !== expected.size) {
      throw new Error(`docs vector coverage incomplete: found ${actual.size}/${expected.size} exact items`);
    }
    await this.verifyPhysicalVectorIds(
      namespace,
      generationId,
      items.flatMap((item) => item.vector_id ? [item.vector_id] : []),
    );
    return expected.size;
  }
};
