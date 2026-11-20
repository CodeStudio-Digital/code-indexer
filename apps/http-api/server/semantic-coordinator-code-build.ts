import {
EmbeddingPauseRequestedError,
retryEmbeddings,
} from '@mcp/indexer/indexer/indexer/embed-retry.js';
import {
semanticItemKeysForIndexedPaths
} from '@mcp/indexer/indexer/indexer/embedding-candidates.js';
import {
codeNamespace
} from '@mcp/shared/vector-namespace.js';
import { isSemanticPath, projectSemanticFolders } from '@mcp/shared/utils/semantic-folders.js';
import { embeddingFingerprintForGeneration } from '@mcp/store/vectors.js';
import {
type SemanticGenerationRow,
type SemanticJobRow
} from '@mcp/store';
import { CodeScopeChangedError,DeltaBuildPendingError,errorMessage,mergeCodeDeltaCursor,readCodeDeltaCursor,type CodeDeltaCursor } from './semantic-coordinator-shared.js';

import type { SemanticCoordinatorContext } from './semantic-coordinator-context.js';

export const operations = {
async buildCodeNamespace(this: SemanticCoordinatorContext,
    projectId: number,
    generation: SemanticGenerationRow,
    force: boolean,
  ): Promise<void> {
    const namespace = codeNamespace(projectId);
    this.assertNamespaceProjectActive(namespace);
    const project = this.deps.db.getProject(projectId);
    if (!project) throw new Error(`Project ${projectId} not found`);
    const folders = projectSemanticFolders(project);
    if (!folders.length) return;
    const assertScope = () => {
      if (this.deps.db.getProjectCatalogEntry(projectId)?.semantic_index_folders !== project.semantic_index_folders) {
        throw new CodeScopeChangedError('Semantic folders changed');
      }
    };
    const before = this.deps.semanticStore.listNamespaceGenerations({ namespace })[0];
    const incrementalActive = !force && before?.active_generation_id === generation.id;
    const resumableDeltaJobs = this.captureCodeDeltaJobs(namespace, generation.id, !incrementalActive);
    if (incrementalActive) {
      await this.drainActiveCodeDeltas(projectId, project.root_path, generation, resumableDeltaJobs, folders, assertScope);
      return;
    }
    const expected = this.deps.db.countFilesInFolders(projectId, folders);
    this.prepareNamespaceGeneration(namespace, 'code', generation.id, expected);
    const deltaJobs = resumableDeltaJobs;
    for (const deltaJob of deltaJobs) {
      this.deps.semanticStore.updateJob(deltaJob.id, { status: 'running', error: null });
    }
    const jobKind = before?.active_generation_id ? 'build' as const : 'backfill' as const;
    const interruptedJob = (await this.listJobsOffThread({ namespace, statuses: ['pending', 'paused', 'running'], kinds: [jobKind] })).find((candidate) =>
      candidate.generation_id === generation.id
      && candidate.kind === jobKind
      && candidate.cursor?.reason !== 'code-delta'
      && (candidate.status === 'pending' || candidate.status === 'paused' || candidate.status === 'running'));
    const job = interruptedJob ?? this.deps.semanticStore.createJob({
      generation_id: generation.id,
      namespace,
      kind: jobKind,
      expected_items: expected,
      priority: 10,
    });
    if (interruptedJob) {
      this.deps.semanticStore.updateJob(job.id, {
        expected_items: expected, processed_items: 0, failed_items: 0, error: null,
      });
    }
    this.deps.semanticStore.updateJob(job.id, { status: 'running' });
    try {
      assertScope();
      const result = await this.runCodeEmbedding(projectId, project.root_path, generation, job.id, assertScope);
      if (result.failedBatches > 0) throw new Error(`${result.failedBatches} embedding batch(es) failed`);
      if (result.skipped > 0) throw new Error(`${result.skipped} source file(s) disappeared during embedding`);

      // Jobs present at the start correspond to structural events already
      // drained before this catch-up. Any job enqueued during embedding still
      // points at not-yet-reconciled structural state and blocks activation.
      const capturedIds = new Set(deltaJobs.map((deltaJob) => deltaJob.id));
      const newerDelta = (await this.listJobsOffThread({ namespace, statuses: ['pending', 'paused', 'running'], kinds: ['delta'] })).some((candidate) =>
        candidate.kind === 'delta'
        && candidate.generation_id === generation.id
        && !capturedIds.has(candidate.id)
        && (candidate.status === 'pending' || candidate.status === 'paused' || candidate.status === 'running'));
      assertScope();
      if (newerDelta) throw new DeltaBuildPendingError(namespace);

      const verifiedItems = await this.verifyCodeVectorCoverage(
        projectId,
        project.root_path,
        generation.id,
        namespace,
        assertScope,
      );
      assertScope();
      const drainedItems = deltaJobs
        .filter((deltaJob) => deltaJob.kind === 'delta')
        .reduce((sum, deltaJob) => sum + Math.max(deltaJob.expected_items, 1), 0);
      for (const deltaJob of deltaJobs) {
        this.deps.semanticStore.updateJob(deltaJob.id, {
          status: 'completed',
          processed_items: deltaJob.expected_items,
          failed_items: 0,
          error: null,
        });
      }
      const state = this.deps.semanticStore.listNamespaceGenerations({ namespace })[0];
      const remainingDelta = Math.max(0, (state?.delta_items ?? 0) - drainedItems);
      if (remainingDelta > 0) throw new DeltaBuildPendingError(namespace);
      this.deps.semanticStore.updateNamespaceProgress(namespace, {
        expected_items: verifiedItems,
        indexed_items: verifiedItems,
        failed_items: 0,
        delta_items: 0,
        last_error: null,
      });
      this.deps.semanticStore.activateNamespaceGeneration(namespace, generation.id);
      this.deps.semanticStore.updateJob(job.id, {
        status: 'completed', processed_items: verifiedItems, failed_items: 0, error: null,
      });
      await this.cleanupGenerationIfUnreferenced(namespace, before?.active_generation_id ?? null);
    } catch (error) {
      if (error instanceof EmbeddingPauseRequestedError || error instanceof CodeScopeChangedError) {
        const message = error instanceof CodeScopeChangedError ? error.message : 'paused because project is not active';
        for (const deltaJob of deltaJobs) {
          const current = this.deps.semanticStore.getJob(deltaJob.id);
          if (current?.status !== 'completed') {
            this.deps.semanticStore.updateJob(deltaJob.id, {
              status: 'paused', failed_items: 0, error: message,
            });
          }
        }
        this.deps.semanticStore.updateNamespaceProgress(namespace, {
          failed_items: 0,
          last_error: null,
        });
        this.deps.semanticStore.updateJob(job.id, {
          status: 'paused', failed_items: 0, error: message,
        });
        throw error;
      }
      if (error instanceof DeltaBuildPendingError) {
        try {
          // The first pass may contain vectors for a file deleted/renamed by
          // the still-draining structural queue. Rebuilding the same table in
          // place would leave those extras searchable, so discard the
          // non-serving construction table and its item ledger first.
          await this.workerDropGeneration(namespace, generation.id);
          this.deps.semanticStore.deleteItemsForNamespaceGeneration(generation.id, namespace);
          this.deps.semanticStore.updateNamespaceProgress(namespace, {
            indexed_items: 0, failed_items: 0, last_error: null,
          });
          for (const deltaJob of deltaJobs) {
            this.deps.semanticStore.updateJob(deltaJob.id, {
              status: 'pending', processed_items: 0, failed_items: 0, error: null,
            });
          }
          this.deps.semanticStore.updateJob(job.id, { status: 'pending', processed_items: 0, failed_items: 0, error: null });
        } catch (resetError) {
          const message = `delta reset failed: ${errorMessage(resetError)}`;
          this.deps.semanticStore.updateNamespaceProgress(namespace, { failed_items: 1, last_error: message });
          this.deps.semanticStore.updateJob(job.id, { status: 'paused', failed_items: 1, error: message });
          throw resetError;
        }
        throw error;
      }
      const message = errorMessage(error);
      for (const deltaJob of deltaJobs) {
        const current = this.deps.semanticStore.getJob(deltaJob.id);
        if (current?.status !== 'completed') {
          this.deps.semanticStore.updateJob(deltaJob.id, { status: 'paused', error: message });
        }
      }
      this.deps.semanticStore.updateNamespaceProgress(namespace, { failed_items: 1, last_error: message });
      this.deps.semanticStore.updateJob(job.id, { status: 'paused', failed_items: 1, error: message });
      throw error;
    }
  },

async drainActiveCodeDeltas(this: SemanticCoordinatorContext,
    projectId: number,
    rootPath: string,
    generation: SemanticGenerationRow,
    initial: SemanticJobRow[],
    folders: readonly string[],
    assertScope: () => void,
  ): Promise<void> {
    const namespace = codeNamespace(projectId);
    let captured = initial;
    for (let pass = 0; pass < 3; pass++) {
      if (captured.length === 0) return;
      for (const job of captured) {
        this.deps.semanticStore.updateJob(job.id, {
          status: 'running', processed_items: 0, failed_items: 0, error: null,
        });
      }
      let cursor: CodeDeltaCursor = { events: [], previous_item_keys: [] };
      for (const job of captured) {
        const next = readCodeDeltaCursor(job.cursor);
        // Jobs written by builds predating the path cursor cannot prove which
        // files changed. Reconcile them conservatively as one bounded full
        // sweep instead of acknowledging an unknown delta without embedding.
        const events = next.events.length > 0
          ? next.events
          : [{ path: '*', kind: 'upsert' as const }];
        cursor = mergeCodeDeltaCursor(cursor, events, next.previous_item_keys);
      }
      const wildcard = cursor.events.some((event) => event.path === '*');
      try {
        assertScope();
        let indexedItems: number;
        if (wildcard) {
          const result = await this.runCodeEmbedding(
            projectId, rootPath, generation, captured[0].id, assertScope, undefined, false,
          );
          if (result.failedBatches > 0) {
            throw new Error(`${result.failedBatches} embedding batch(es) failed`);
          }
          indexedItems = await this.verifyCodeVectorCoverage(
            projectId, rootPath, generation.id, namespace, assertScope,
          );
        } else {
          const latestByPath = new Map(cursor.events.map((event) => [event.path, event]));
          const upsertPaths = [...latestByPath.values()]
            .filter((event) => event.kind === 'upsert' && isSemanticPath(folders, event.path))
            .map((event) => event.path);
          const currentKeys = new Set(semanticItemKeysForIndexedPaths(
            this.deps.db,
            projectId,
            upsertPaths,
          ));
          const obsoleteKeys = cursor.previous_item_keys.filter((key) => !currentKeys.has(key));
          if (obsoleteKeys.length > 0) {
            const staleIds = this.deps.semanticStore.listItems({
              generation_id: generation.id,
              namespace,
              item_keys: obsoleteKeys,
            }).flatMap((item) => item.vector_id ? [item.vector_id] : []);
            await this.workerDeleteItemKeys(namespace, generation.id, obsoleteKeys);
            try { await this.deps.lshSink.afterDelete?.(projectId, staleIds); }
            catch { /* LSH is best-effort. */ }
          }
          if (upsertPaths.length > 0) {
            const result = await this.runCodeEmbedding(
              projectId, rootPath, generation, captured[0].id, assertScope, upsertPaths, false,
            );
            if (result.failedBatches > 0) {
              throw new Error(`${result.failedBatches} embedding batch(es) failed`);
            }
          }
          const items = this.deps.semanticStore.listItems({
            generation_id: generation.id,
            namespace,
          });
          const incomplete = items.find((item) => item.status !== 'indexed' || !item.vector_id);
          if (incomplete) throw new Error(`code delta incomplete: ${incomplete.item_key}`);
          indexedItems = items.length;
        }

        assertScope();
        const finish = this.deps.semanticStore.finishNamespaceMutationPass({
          namespace,
          generation_id: generation.id,
          expected_items: indexedItems,
          indexed_items: indexedItems,
          captured_jobs: captured.map((job) => ({ id: job.id, expected_items: job.expected_items })),
          activate: false,
        });
        if (!finish.pending) return;
        captured = this.captureCodeDeltaJobs(namespace, generation.id);
      } catch (error) {
        const message = errorMessage(error);
        const paused = error instanceof EmbeddingPauseRequestedError || error instanceof CodeScopeChangedError;
        for (const job of captured) {
          const current = this.deps.semanticStore.getJob(job.id);
          if (current?.status !== 'completed') {
            this.deps.semanticStore.updateJob(job.id, {
              status: 'paused',
              failed_items: paused ? 0 : 1,
              error: paused ? 'paused because project is not active' : message,
            });
          }
        }
        this.deps.semanticStore.updateNamespaceProgress(namespace, {
          failed_items: paused ? 0 : 1,
          last_error: paused ? null : message,
        });
        throw error;
      }
    }
    throw new DeltaBuildPendingError(namespace);
  },

captureCodeDeltaJobs(this: SemanticCoordinatorContext,
    namespace: string,
    generationId: number,
    includePreviousGenerations = false,
  ): SemanticJobRow[] {
    const relevant = (candidate: SemanticJobRow): boolean =>
      ((candidate.kind === 'delta'
        && (candidate.generation_id === generationId || includePreviousGenerations))
        || (candidate.kind === 'backfill'
          && candidate.generation_id === null
          && candidate.cursor?.reason === 'code-delta'))
      && (candidate.status === 'pending'
        || candidate.status === 'paused'
        || candidate.status === 'running');
    const jobs = this.deps.semanticStore.listJobs({ namespace, statuses: ['pending', 'paused', 'running'], kinds: ['delta', 'backfill'] }).filter(relevant);
    for (const job of jobs) {
      if (job.status !== 'running') continue;
      this.deps.semanticStore.updateJob(job.id, {
        status: 'pending',
        processed_items: 0,
        failed_items: 0,
        error: null,
      });
    }
    return this.deps.semanticStore.listJobs({ namespace, statuses: ['pending', 'paused', 'running'], kinds: ['delta', 'backfill'] }).filter((candidate) =>
      relevant(candidate) && (candidate.status === 'pending' || candidate.status === 'paused'));
  },

runCodeEmbedding(this: SemanticCoordinatorContext,
    projectId: number,
    rootPath: string,
    generation: SemanticGenerationRow,
    jobId: number | null,
    assertScope: () => void,
    paths?: readonly string[],
    reportNamespaceProgress = true,
  ) {
    return retryEmbeddings({
      db: this.deps.db,
      embeddingService: this.deps.codeEmbeddingForProject?.(projectId) ?? this.deps.codeEmbedding,
      vectorStore: this.deps.vectorStore,
      costTracker: this.deps.costTracker,
      lshSink: this.deps.lshSink,
      indexProfile: this.deps.indexProfile,
    }, rootPath, {
      onProgress: (progress) => {
        if (jobId) this.deps.semanticStore.updateJob(jobId, { processed_items: progress.current });
        if (reportNamespaceProgress) {
          this.deps.semanticStore.updateNamespaceProgress(codeNamespace(projectId), {
            indexed_items: progress.current,
          });
        }
      },
      embeddingFingerprint: embeddingFingerprintForGeneration(generation.fingerprint),
      shouldPause: () => {
        assertScope();
        return this.shouldPauseCodeProject(projectId);
      },
      ...(paths ? { paths } : {}),
    });
  }
};
