import type { EmbeddingService } from '@mcp/indexer/search/embeddings.js';
import { NullEmbeddingService } from '@mcp/indexer/search/embeddings.js';
import {
docNamespace
} from '@mcp/shared/vector-namespace.js';
import {
type SemanticJobRow,
type SemanticPurpose
} from '@mcp/store';
import { DOCS_BACKFILL_RETRY_MS,errorMessage,type ReindexResult } from './semantic-coordinator-shared.js';

import type { SemanticCoordinatorContext } from './semantic-coordinator-context.js';

export const operations = {
docsCollectionExists(this: SemanticCoordinatorContext, collectionId: number): boolean {
    return this.deps.docStore.listCollections().some((collection) => collection.id === collectionId);
  },

embeddingForPurpose(this: SemanticCoordinatorContext, purpose: SemanticPurpose): EmbeddingService {
    if (purpose === 'code') return this.deps.codeEmbedding;
    if (purpose === 'docs') return this.deps.docsEmbedding;
    return this.deps.memoryEmbedding;
  },

embeddingDisabled(this: SemanticCoordinatorContext, purpose: SemanticPurpose, projectId?: number): boolean {
    const profile = this.deps.semanticStore.getProfile(purpose);
    if (purpose === 'code' && projectId !== undefined && this.deps.semanticStore.getProjectTargets?.(projectId)?.embedding_target.kind === 'disabled') return true;
    if (profile) return profile.embedding_target.kind === 'disabled';
    const embedding = this.embeddingForPurpose(purpose);
    if (embedding instanceof NullEmbeddingService) return true;
    try {
      return embedding.fingerprint?.() === 'null';
    } catch {
      return false;
    }
  },

disabledResult(this: SemanticCoordinatorContext, purpose: SemanticPurpose): ReindexResult {
    return {
      purpose,
      generation_id: null,
      completed_namespaces: [],
      failed_namespaces: [],
      skipped: 'disabled',
    };
  },

async pauseDocsBackfillsForDisabled(this: SemanticCoordinatorContext): Promise<void> {
    for (const candidate of await this.pendingDocsBackfillJobs()) {
      const job = this.currentDocsBackfill(candidate.id);
      if (!job) continue;
      if (job.status === 'paused' && job.error === 'docs semantic profile is disabled') continue;
      this.deps.semanticStore.updateJob(job.id, {
        status: 'paused',
        error: 'docs semantic profile is disabled',
      });
    }
  },

queueDocsBackfill(this: SemanticCoordinatorContext, collectionId: number, error: unknown): void {
    if (this.embeddingDisabled('docs') || !this.docsCollectionExists(collectionId)) return;
    this.deps.semanticStore.enqueueNamespaceBackfill({
      namespace: docNamespace(collectionId),
      priority: 80,
      cursor: {
        collection_id: collectionId,
        requested_at_ms: Date.now(),
      },
      error: errorMessage(error),
    });
    this.scheduleDocsBackfillRetry();
  },

async pendingDocsBackfillJobs(this: SemanticCoordinatorContext): Promise<SemanticJobRow[]> {
    return (await this.listJobsOffThread({
      statuses: ['pending', 'paused', 'running'],
      kinds: ['backfill'],
      namespacePrefix: 'docs:c', generationId: null,
    })).filter((job) =>
      job.generation_id === null
      && job.kind === 'backfill'
      && /^docs:c\d+$/.test(job.namespace)
      && (job.status === 'pending' || job.status === 'paused' || job.status === 'running')
    );
  },

async hasPendingDocsBackfills(this: SemanticCoordinatorContext): Promise<boolean> {
    return (await this.pendingDocsBackfillJobs()).length > 0;
  },

currentDocsBackfill(this: SemanticCoordinatorContext, id: number): SemanticJobRow | null {
    // The worker query may overlap a completed/cancelled job or a cursor
    // update. Re-read only the selected candidate before claiming it.
    const job = this.deps.semanticStore.getJob(id);
    return job && job.kind === 'backfill' && job.generation_id === null
      && /^docs:c\d+$/.test(job.namespace) && ['pending', 'paused', 'running'].includes(job.status) ? job : null;
  },

scheduleDocsBackfillRetry(this: SemanticCoordinatorContext, delayMs = DOCS_BACKFILL_RETRY_MS): void {
    if (
      this.disposed
      || this.embeddingDisabled('docs')
      || this.docsBackfillTimer
      || this.docsBackfillRun
    ) return;
    this.docsBackfillTimer = setTimeout(() => {
      this.docsBackfillTimer = null;
      void this.retryPendingDocsBackfills().catch((error) =>
        console.warn(`[semantic] docs backfill retry paused: ${errorMessage(error)}`));
    }, Math.max(1, delayMs));
    this.docsBackfillTimer.unref?.();
  },

async drainPendingDocsBackfills(this: SemanticCoordinatorContext): Promise<number> {
    if (this.embeddingDisabled('docs')) {
      await this.pauseDocsBackfillsForDisabled();
      return 0;
    }
    let completed = 0;
    for (const candidate of await this.pendingDocsBackfillJobs()) {
      const job = this.currentDocsBackfill(candidate.id);
      if (!job) continue;
      if (this.embeddingDisabled('docs')) {
        await this.pauseDocsBackfillsForDisabled();
        return completed;
      }
      const match = /^docs:c(\d+)$/.exec(job.namespace);
      const collectionId = Number(match?.[1]);
      if (!Number.isSafeInteger(collectionId) || !this.docsCollectionExists(collectionId)) {
        this.deps.semanticStore.updateJob(job.id, {
          status: 'cancelled',
          error: 'documentation collection no longer exists',
        });
        continue;
      }
      const cursor = {
        ...(job.cursor ?? {}),
        collection_id: collectionId,
        attempt: Math.max(0, Number(job.cursor?.attempt) || 0) + 1,
        last_attempt_at_ms: Date.now(),
      };
      this.deps.semanticStore.updateJob(job.id, {
        status: 'running', cursor, error: null,
      });
      try {
        await this.prepareDocsCollection(collectionId);
        await this.ensureDocsCollection(collectionId);
        if (this.embeddingDisabled('docs')) {
          this.deps.semanticStore.updateJob(job.id, {
            status: 'paused',
            cursor,
            error: 'docs semantic profile is disabled',
          });
          return completed;
        }
        this.deps.semanticStore.updateJob(job.id, {
          status: 'completed',
          cursor,
          processed_items: 1,
          failed_items: 0,
          error: null,
        });
        completed++;
      } catch (error) {
        this.deps.semanticStore.updateJob(job.id, {
          status: 'paused',
          cursor,
          failed_items: job.failed_items + 1,
          error: errorMessage(error),
        });
      }
    }
    return completed;
  }
};
