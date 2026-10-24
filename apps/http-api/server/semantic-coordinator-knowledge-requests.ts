import {
docNamespace,
userMemoryNamespace
} from '@mcp/shared/vector-namespace.js';
import {
semanticPurposeForNamespace
} from '@mcp/store';
import { randomUUID } from 'node:crypto';
import { errorMessage } from './semantic-coordinator-shared.js';
import { SemanticRetryDeferredError } from './semantic-retry-policy.js';

import type { SemanticCoordinatorContext } from './semantic-coordinator-context.js';

export const operations = {
ensureMemoryNamespace(this: SemanticCoordinatorContext, namespace: string): Promise<void> {
    if (semanticPurposeForNamespace(namespace) !== 'memory') {
      return Promise.reject(new Error(`Unsupported Memory mutation namespace: ${namespace}`));
    }
    if (this.embeddingDisabled('memory')) return Promise.resolve();
    if (!this.allowsNamespaceMutation(namespace)) return Promise.resolve();
    return this.serial(namespace, async () => {
      if (this.embeddingDisabled('memory') || !this.allowsNamespaceMutation(namespace)) return;
      const generation = await this.ensureGeneration('memory', false);
      try {
        const snapshot = /^snapshot:p(\d+)$/.exec(namespace);
        const projectMemory = /^memory:project:p(\d+)$/.exec(namespace);
        if (snapshot) {
          await this.buildSnapshotNamespace(Number(snapshot[1]), generation, false);
        } else if (projectMemory) {
          await this.buildMemoryNamespace('project', Number(projectMemory[1]), generation, false);
        } else if (namespace === userMemoryNamespace()) {
          await this.buildMemoryNamespace('user', 0, generation, false);
        } else {
          throw new Error(`Unsupported Memory mutation namespace: ${namespace}`);
        }
      } finally {
        this.refreshGenerationProgress(generation.id);
      }
    });
  },

async catchUpMemoryNamespace(this: SemanticCoordinatorContext, namespace: string): Promise<void> {
    await this.ensureMutationFenceRecovery();
    if (semanticPurposeForNamespace(namespace) !== 'memory') return Promise.resolve();
    if (this.embeddingDisabled('memory') || !this.allowsNamespaceMutation(namespace)) {
      return Promise.resolve();
    }
    const state = this.deps.semanticStore.listNamespaceGenerations({ namespace })[0];
    if (!state?.active_generation_id && !state?.building_generation_id) return Promise.resolve();
    const retry = this.deps.semanticStore.getNamespaceBuildRetry(namespace);
    if (retry?.blocked || (retry?.not_before_ms ?? 0) > Date.now()) {
      throw new SemanticRetryDeferredError(retry?.blocked ? Infinity : retry!.not_before_ms);
    }
    return this.ensureMemoryNamespace(namespace);
  },

async beginDocsCollectionMutation(this: SemanticCoordinatorContext,
    collectionId: number,
    operation: 'upsert' | 'delete',
  ): Promise<{ job_id: number; token: string } | null> {
    await this.ensureMutationFenceRecovery();
    let fence: { job_id: number; token: string } | null = null;
    await this.serial(docNamespace(collectionId), async () => {
      // Recheck inside the lock: collection deletion may have been ahead of
      // this request while waiting on a vector checkpoint.
      if (!this.docsCollectionExists(collectionId)) {
        throw new Error(`Documentation collection ${collectionId} not found`);
      }
      if (this.embeddingDisabled('docs')) return;
      const token = randomUUID();
      const job = this.deps.semanticStore.noteNamespaceMutation({
        namespace: docNamespace(collectionId),
        itemKeys: ['*'],
        operation,
        fence: { token, owner: this.docsMutationOwner },
      });
      fence = { job_id: job.id, token };
    });
    return fence;
  },

endDocsCollectionMutation(this: SemanticCoordinatorContext,
    fence: { job_id: number; token: string } | null,
    mutationError: unknown = null,
  ): void {
    if (!fence) return;
    this.deps.semanticStore.settleNamespaceMutationFence({
      ...fence,
      mutation_error: mutationError == null ? null : errorMessage(mutationError),
    });
  },

async runDocsCollectionExclusive<T>(this: SemanticCoordinatorContext,
    collectionId: number,
    operation: () => Promise<T>,
  ): Promise<T> {
    let result!: T;
    await this.serial(docNamespace(collectionId), async () => {
      const inFlight = this.deps.semanticStore.hasLiveMutationFence(docNamespace(collectionId));
      if (inFlight) {
        throw new Error(`Documentation collection ${collectionId} is currently being mutated`);
      }
      result = await operation();
    });
    return result;
  },

async prepareDocsCollection(this: SemanticCoordinatorContext, collectionId: number): Promise<void> {
    const namespace = docNamespace(collectionId);
    if (!this.docsCollectionExists(collectionId)) {
      throw new Error(`Documentation collection ${collectionId} not found`);
    }
    if (this.embeddingDisabled('docs')) return;
    try {
      await this.serial(namespace, async () => {
        if (this.embeddingDisabled('docs')) return;
        const generation = await this.ensureGeneration('docs', false);
        const state = this.deps.semanticStore.listNamespaceGenerations({ namespace })[0];
        // An incremental ingest writes into the already-serving generation.
        // Pointing `building` at that same id violates migration 227's CHECK
        // and is unnecessary because the pre-mutation fence blocks races.
        if (state?.active_generation_id !== generation.id) {
          this.prepareNamespaceGeneration(
            namespace,
            'docs',
            generation.id,
            this.deps.docStore.countChunksByCollection(collectionId),
          );
        }
        this.refreshGenerationProgress(generation.id);
      });
    } catch (error) {
      if (this.embeddingDisabled('docs')) return;
      this.queueDocsBackfill(collectionId, error);
      throw error;
    }
  },

async ensureDocsCollection(this: SemanticCoordinatorContext, collectionId: number): Promise<void> {
    const namespace = docNamespace(collectionId);
    if (!this.docsCollectionExists(collectionId)) {
      throw new Error(`Documentation collection ${collectionId} not found`);
    }
    if (this.embeddingDisabled('docs')) return;
    try {
      await this.serial(namespace, async () => {
        if (this.embeddingDisabled('docs')) return;
        const generation = await this.ensureGeneration('docs', false);
        try {
          await this.buildDocsNamespace(collectionId, generation, false);
        } finally {
          this.refreshGenerationProgress(generation.id);
        }
      });
    } catch (error) {
      if (this.embeddingDisabled('docs')) return;
      this.queueDocsBackfill(collectionId, error);
      throw error;
    }
  },

retryPendingDocsBackfills(this: SemanticCoordinatorContext): Promise<number> {
    if (this.docsBackfillRun) return this.docsBackfillRun;
    const run = this.drainPendingDocsBackfills().finally(async () => {
      try {
        if (!this.embeddingDisabled('docs') && await this.hasPendingDocsBackfills()) {
          // Release the in-flight owner only after the worker query, so a
          // concurrent retry cannot start another scan during finalization.
          if (this.docsBackfillRun === run) this.docsBackfillRun = null;
          this.scheduleDocsBackfillRetry();
        }
      } finally { if (this.docsBackfillRun === run) this.docsBackfillRun = null; }
    });
    this.docsBackfillRun = run;
    return run;
  }
};
