import type { EmbeddingRetryResult } from '@mcp/indexer/indexer/indexer/embed-retry.js';
import type { EmbeddingService } from '@mcp/indexer/search/embeddings.js';
import type { DirtyEvent } from '@mcp/services/services/project-index/index.js';
import type { AgentMemoryRow } from '@mcp/shared/types.js';
import {
type SemanticGenerationRow,
type SemanticJobRow,
type SemanticPurpose,
type SemanticStore
} from '@mcp/store';
import { type CoordinatorDeps,type ProjectRemovalOptions,type ReindexResult,type SemanticUnusedVectorCleanupResult } from './semantic-coordinator-shared.js';

import type { SemanticCoordinatorContext } from './semantic-coordinator-context.js';
import { createSemanticCoordinator } from './semantic-coordinator-create.js';



/** Public lifecycle/API facade; indexing operations share one private context. */
export class SemanticIndexCoordinator {
  readonly #context: SemanticCoordinatorContext;
  readonly #implementation: Pick<SemanticCoordinatorContext, "allowsNamespaceMutation" | "reindex" | "activateCodeProject" | "deactivateCodeProject" | "acquireCodeProjectLease" | "pauseJob" | "resumeJob" | "cleanupUnusedVectors" | "ensureCodeProject" | "catchUpCodeProject" | "reindexCodeProject" | "enqueueCodeProjectReindex" | "ensureMemoryNamespace" | "catchUpMemoryNamespace" | "beginDocsCollectionMutation" | "endDocsCollectionMutation" | "runDocsCollectionExclusive" | "prepareDocsCollection" | "ensureDocsCollection" | "retryPendingDocsBackfills" | "noteCodeDelta" | "removeProject" | "recoverInterruptedJobsPassively" | "dispose" | "retryPendingProjectRemovals">;
  constructor(deps: CoordinatorDeps) {
    this.#context = createSemanticCoordinator(deps);
    this.#implementation = {
      allowsNamespaceMutation: this.#context.allowsNamespaceMutation.bind(this.#context),
      reindex: this.#context.reindex.bind(this.#context),
      activateCodeProject: this.#context.activateCodeProject.bind(this.#context),
      deactivateCodeProject: this.#context.deactivateCodeProject.bind(this.#context),
      acquireCodeProjectLease: this.#context.acquireCodeProjectLease.bind(this.#context),
      pauseJob: this.#context.pauseJob.bind(this.#context),
      resumeJob: this.#context.resumeJob.bind(this.#context),
      cleanupUnusedVectors: this.#context.cleanupUnusedVectors.bind(this.#context),
      ensureCodeProject: this.#context.ensureCodeProject.bind(this.#context),
      catchUpCodeProject: this.#context.catchUpCodeProject.bind(this.#context),
      reindexCodeProject: this.#context.reindexCodeProject.bind(this.#context),
      enqueueCodeProjectReindex: this.#context.enqueueCodeProjectReindex.bind(this.#context),
      ensureMemoryNamespace: this.#context.ensureMemoryNamespace.bind(this.#context),
      catchUpMemoryNamespace: this.#context.catchUpMemoryNamespace.bind(this.#context),
      beginDocsCollectionMutation: this.#context.beginDocsCollectionMutation.bind(this.#context),
      endDocsCollectionMutation: this.#context.endDocsCollectionMutation.bind(this.#context),
      runDocsCollectionExclusive: this.#context.runDocsCollectionExclusive.bind(this.#context),
      prepareDocsCollection: this.#context.prepareDocsCollection.bind(this.#context),
      ensureDocsCollection: this.#context.ensureDocsCollection.bind(this.#context),
      retryPendingDocsBackfills: this.#context.retryPendingDocsBackfills.bind(this.#context),
      noteCodeDelta: this.#context.noteCodeDelta.bind(this.#context),
      removeProject: this.#context.removeProject.bind(this.#context),
      recoverInterruptedJobsPassively: this.#context.recoverInterruptedJobsPassively.bind(this.#context),
      dispose: this.#context.dispose.bind(this.#context),
      retryPendingProjectRemovals: this.#context.retryPendingProjectRemovals.bind(this.#context),
    };
    // Calls made by domain operations still dispatch through the public facade.
    this.#context.allowsNamespaceMutation = (namespace) => this.allowsNamespaceMutation(namespace);
    this.#context.reindex = (purpose, force) => this.reindex(purpose, force);
    this.#context.activateCodeProject = (projectId, leaseId) => this.activateCodeProject(projectId, leaseId);
    this.#context.deactivateCodeProject = (projectId, leaseId) => this.deactivateCodeProject(projectId, leaseId);
    this.#context.acquireCodeProjectLease = (projectId, leaseId) => this.acquireCodeProjectLease(projectId, leaseId);
    this.#context.pauseJob = (jobId) => this.pauseJob(jobId);
    this.#context.resumeJob = (jobId) => this.resumeJob(jobId);
    this.#context.cleanupUnusedVectors = (projectId) => this.cleanupUnusedVectors(projectId);
    this.#context.ensureCodeProject = (projectId) => this.ensureCodeProject(projectId);
    this.#context.catchUpCodeProject = (projectId) => this.catchUpCodeProject(projectId);
    this.#context.reindexCodeProject = (...args) => this.reindexCodeProject(...args);
    this.#context.enqueueCodeProjectReindex = (...args) => this.enqueueCodeProjectReindex(...args);
    this.#context.ensureMemoryNamespace = (namespace, force, beforeStart) => this.ensureMemoryNamespace(namespace, force, beforeStart);
    this.#context.catchUpMemoryNamespace = (namespace) => this.catchUpMemoryNamespace(namespace);
    this.#context.beginDocsCollectionMutation = (collectionId, operation) => this.beginDocsCollectionMutation(collectionId, operation);
    this.#context.endDocsCollectionMutation = (fence, mutationError) => this.endDocsCollectionMutation(fence, mutationError);
    this.#context.runDocsCollectionExclusive = (collectionId, operation) => this.runDocsCollectionExclusive(collectionId, operation);
    this.#context.prepareDocsCollection = (collectionId) => this.prepareDocsCollection(collectionId);
    this.#context.ensureDocsCollection = (collectionId) => this.ensureDocsCollection(collectionId);
    this.#context.retryPendingDocsBackfills = () => this.retryPendingDocsBackfills();
    this.#context.noteCodeDelta = (projectId, events, previousItemKeys) => this.noteCodeDelta(projectId, events, previousItemKeys);
    this.#context.removeProject = (projectId, options) => this.removeProject(projectId, options);
    this.#context.recoverInterruptedJobsPassively = () => this.recoverInterruptedJobsPassively();
    this.#context.dispose = () => this.dispose();
    this.#context.retryPendingProjectRemovals = () => this.retryPendingProjectRemovals();
  }
  private listJobsOffThread(filter: Parameters<SemanticStore['listJobs']>[0]): Promise<SemanticJobRow[]> { return this.#context.listJobsOffThread(filter); }
  private recoverMutationFencesLocallyFailFast(): void { return this.#context.recoverMutationFencesLocallyFailFast(); }
  private startMutationFenceRecovery(): Promise<void> { return this.#context.startMutationFenceRecovery(); }
  private ensureMutationFenceRecovery(): Promise<void> { return this.#context.ensureMutationFenceRecovery(); }
  allowsNamespaceMutation(namespace: string): boolean { return this.#implementation.allowsNamespaceMutation(namespace); }
  reindex(purpose: SemanticPurpose, force?: boolean): Promise<ReindexResult> { return this.#implementation.reindex(purpose, force); }
  activateCodeProject(projectId: number, leaseId?: string): SemanticJobRow | null { return this.#implementation.activateCodeProject(projectId, leaseId); }
  deactivateCodeProject(projectId: number, leaseId?: string): boolean { return this.#implementation.deactivateCodeProject(projectId, leaseId); }
  acquireCodeProjectLease(projectId: number, leaseId: string): () => void { return this.#implementation.acquireCodeProjectLease(projectId, leaseId); }
  pauseJob(jobId: number): SemanticJobRow { return this.#implementation.pauseJob(jobId); }
  resumeJob(jobId: number): SemanticJobRow { return this.#implementation.resumeJob(jobId); }
  cleanupUnusedVectors(projectId?: number): Promise<SemanticUnusedVectorCleanupResult> { return this.#implementation.cleanupUnusedVectors(projectId); }
  private performUnusedVectorCleanup(projectId?: number): Promise<SemanticUnusedVectorCleanupResult> { return this.#context.performUnusedVectorCleanup(projectId); }
  ensureCodeProject(projectId: number): Promise<void> { return this.#implementation.ensureCodeProject(projectId); }
  catchUpCodeProject(projectId: number): Promise<void> { return this.#implementation.catchUpCodeProject(projectId); }
  reindexCodeProject(projectId: number, force?: boolean, preserveGeneration?: boolean): Promise<ReindexResult> {
    return this.#implementation.reindexCodeProject(projectId, force, preserveGeneration);
  }
  setCodeProjectFolders(projectId: number, folders: readonly string[]): void {
    this.#context.setCodeProjectFolders(projectId, folders);
  }
  enqueueCodeProjectReindex(...args: Parameters<SemanticCoordinatorContext['enqueueCodeProjectReindex']>): SemanticJobRow { return this.#implementation.enqueueCodeProjectReindex(...args); }
  private dispatchCodeProjectReindex(projectId: number, jobId: number): void { return this.#context.dispatchCodeProjectReindex(projectId, jobId); }
  private coalesceCodeCatchup(projectId: number, operation: () => Promise<void>): Promise<void> { return this.#context.coalesceCodeCatchup(projectId, operation); }
  private runCodeProjectBuild(projectId: number, generation: SemanticGenerationRow, force: boolean): Promise<void> { return this.#context.runCodeProjectBuild(projectId, generation, force); }
  private shouldPauseCodeProject(projectId: number): boolean { return this.#context.shouldPauseCodeProject(projectId); }
  private codeProjectIdForJob(job: SemanticJobRow): number | null { return this.#context.codeProjectIdForJob(job); }
  private semanticProjectIdForJob(job: SemanticJobRow): number | null { return this.#context.semanticProjectIdForJob(job); }
  ensureMemoryNamespace(namespace: string, force?: boolean, beforeStart?: () => void): Promise<void> { return this.#implementation.ensureMemoryNamespace(namespace, force, beforeStart); }
  catchUpMemoryNamespace(namespace: string): Promise<void> { return this.#implementation.catchUpMemoryNamespace(namespace); }
  beginDocsCollectionMutation(collectionId: number, operation: 'upsert' | 'delete'): Promise<{ job_id: number; token: string } | null> { return this.#implementation.beginDocsCollectionMutation(collectionId, operation); }
  endDocsCollectionMutation(fence: { job_id: number; token: string } | null, mutationError?: unknown): void { return this.#implementation.endDocsCollectionMutation(fence, mutationError); }
  runDocsCollectionExclusive<T>(collectionId: number, operation: () => Promise<T>): Promise<T> { return this.#implementation.runDocsCollectionExclusive(collectionId, operation); }
  prepareDocsCollection(collectionId: number): Promise<void> { return this.#implementation.prepareDocsCollection(collectionId); }
  ensureDocsCollection(collectionId: number): Promise<void> { return this.#implementation.ensureDocsCollection(collectionId); }
  retryPendingDocsBackfills(): Promise<number> { return this.#implementation.retryPendingDocsBackfills(); }
  noteCodeDelta(projectId: number, events?: readonly DirtyEvent[], previousItemKeys?: readonly string[]): void { return this.#implementation.noteCodeDelta(projectId, events, previousItemKeys); }
  private persistCodeDelta(projectId: number, events: readonly DirtyEvent[], previousItemKeys: readonly string[]): void { return this.#context.persistCodeDelta(projectId, events, previousItemKeys); }
  private queueCodeDeltaRetry(projectId: number, events: readonly DirtyEvent[], previousItemKeys: readonly string[]): void { return this.#context.queueCodeDeltaRetry(projectId, events, previousItemKeys); }
  removeProject(projectId: number, options?: ProjectRemovalOptions): Promise<void> { return this.#implementation.removeProject(projectId, options); }
  private performProjectRemoval(projectId: number, options: ProjectRemovalOptions): Promise<void> { return this.#context.performProjectRemoval(projectId, options); }
  recoverInterruptedJobsPassively(): void { return this.#implementation.recoverInterruptedJobsPassively(); }
  private jobGenerationIsReferenced(job: SemanticJobRow): boolean { return this.#context.jobGenerationIsReferenced(job); }
  dispose(): Promise<void> { return this.#implementation.dispose(); }
  private drainForDisposal(): Promise<void> { return this.#context.drainForDisposal(); }
  private recoverExpiredMemoryMutationFences(now?: number): number { return this.#context.recoverExpiredMemoryMutationFences(now); }
  retryPendingProjectRemovals(): Promise<number> { return this.#implementation.retryPendingProjectRemovals(); }
  private scheduleProjectRemovalRetry(delayMs?: number): void { return this.#context.scheduleProjectRemovalRetry(delayMs); }
  private drainPendingProjectRemovals(): Promise<number> { return this.#context.drainPendingProjectRemovals(); }
  private docsCollectionExists(collectionId: number): boolean { return this.#context.docsCollectionExists(collectionId); }
  private embeddingForPurpose(purpose: SemanticPurpose): EmbeddingService { return this.#context.embeddingForPurpose(purpose); }
  private embeddingDisabled(purpose: SemanticPurpose): boolean { return this.#context.embeddingDisabled(purpose); }
  private disabledResult(purpose: SemanticPurpose): ReindexResult { return this.#context.disabledResult(purpose); }
  private pauseDocsBackfillsForDisabled(): Promise<void> { return this.#context.pauseDocsBackfillsForDisabled(); }
  private queueDocsBackfill(collectionId: number, error: unknown): void { return this.#context.queueDocsBackfill(collectionId, error); }
  private pendingDocsBackfillJobs(): Promise<SemanticJobRow[]> { return this.#context.pendingDocsBackfillJobs(); }
  private hasPendingDocsBackfills(): Promise<boolean> { return this.#context.hasPendingDocsBackfills(); }
  private currentDocsBackfill(id: number): SemanticJobRow | null { return this.#context.currentDocsBackfill(id); }
  private scheduleDocsBackfillRetry(delayMs?: number): void { return this.#context.scheduleDocsBackfillRetry(delayMs); }
  private drainPendingDocsBackfills(): Promise<number> { return this.#context.drainPendingDocsBackfills(); }
  private runPurpose(purpose: SemanticPurpose, force: boolean): Promise<ReindexResult> { return this.#context.runPurpose(purpose, force); }
  private ensureGeneration(purpose: SemanticPurpose, force: boolean): Promise<SemanticGenerationRow> { return this.#context.ensureGeneration(purpose, force); }
  private resolveGeneration(purpose: SemanticPurpose, force: boolean): Promise<SemanticGenerationRow> { return this.#context.resolveGeneration(purpose, force); }
  private assertSingleActiveGenerationPerFile(purpose: SemanticPurpose): void { return this.#context.assertSingleActiveGenerationPerFile(purpose); }
  private workerDropGeneration(namespace: string, generationId: number): Promise<void> { return this.#context.workerDropGeneration(namespace, generationId); }
  private workerListIds(namespace: string, generationId: number): Promise<string[]> { return this.#context.workerListIds(namespace, generationId); }
  private workerDeleteIds(namespace: string, generationId: number, ids: string[]): Promise<number> { return this.#context.workerDeleteIds(namespace, generationId, ids); }
  private workerDeleteItemKeys(namespace: string, generationId: number, itemKeys: string[]): Promise<number> { return this.#context.workerDeleteItemKeys(namespace, generationId, itemKeys); }
  private workerRemoveProject(projectId: number): Promise<void> { return this.#context.workerRemoveProject(projectId); }
  private recoverPendingCleanupJobs(purpose: SemanticPurpose): Promise<void> { return this.#context.recoverPendingCleanupJobs(purpose); }
  private recoverAbandonedBuildingGenerations(purpose: SemanticPurpose): Promise<void> { return this.#context.recoverAbandonedBuildingGenerations(purpose); }
  private performCleanupJob(job: SemanticJobRow): Promise<number> { return this.#context.performCleanupJob(job); }
  private assertNamespaceProjectActive(namespace: string): void { return this.#context.assertNamespaceProjectActive(namespace); }
  private prepareNamespaceGeneration(namespace: string, purpose: SemanticPurpose, generationId: number, expectedItems: number): void { return this.#context.prepareNamespaceGeneration(namespace, purpose, generationId, expectedItems); }
  private buildCodeNamespace(projectId: number, generation: SemanticGenerationRow, force: boolean): Promise<void> { return this.#context.buildCodeNamespace(projectId, generation, force); }
  private drainActiveCodeDeltas(...args: Parameters<SemanticCoordinatorContext['drainActiveCodeDeltas']>): Promise<void> { return this.#context.drainActiveCodeDeltas(...args); }
  private captureCodeDeltaJobs(namespace: string, generationId: number, includePreviousGenerations?: boolean): SemanticJobRow[] { return this.#context.captureCodeDeltaJobs(namespace, generationId, includePreviousGenerations); }
  private runCodeEmbedding(...args: Parameters<SemanticCoordinatorContext['runCodeEmbedding']>): Promise<EmbeddingRetryResult> { return this.#context.runCodeEmbedding(...args); }
  private verifyCodeVectorCoverage(...args: Parameters<SemanticCoordinatorContext['verifyCodeVectorCoverage']>): Promise<number> { return this.#context.verifyCodeVectorCoverage(...args); }
  private buildDocsNamespace(collectionId: number, generation: SemanticGenerationRow, force: boolean): Promise<void> { return this.#context.buildDocsNamespace(collectionId, generation, force); }
  private verifyDocsVectorCoverage(collectionId: number, generationId: number, namespace: string): Promise<number> { return this.#context.verifyDocsVectorCoverage(collectionId, generationId, namespace); }
  private buildSnapshotNamespace(projectId: number, generation: SemanticGenerationRow, force: boolean): Promise<void> { return this.#context.buildSnapshotNamespace(projectId, generation, force); }
  private buildMemoryNamespace(scope: 'project' | 'user', projectId: number, generation: SemanticGenerationRow, force: boolean): Promise<void> { return this.#context.buildMemoryNamespace(scope, projectId, generation, force); }
  private targetedMemoryMutationKeys(captured: readonly SemanticJobRow[]): string[] | null { return this.#context.targetedMemoryMutationKeys(captured); }
  private reconcileTargetedMemoryMutation(scope: 'project' | 'user', projectId: number, generation: SemanticGenerationRow, namespace: string, itemKeys: readonly string[]): Promise<{ namespaceItems: number; processedKeys: number }> { return this.#context.reconcileTargetedMemoryMutation(scope, projectId, generation, namespace, itemKeys); }
  private captureDocsMutationJobs(namespace: string): SemanticJobRow[] { return this.#context.captureDocsMutationJobs(namespace); }
  private hasOpenDocsMutationJobs(namespace: string): boolean { return this.#context.hasOpenDocsMutationJobs(namespace); }
  private hasLiveDocsMutationFence(namespace: string): boolean { return this.#context.hasLiveDocsMutationFence(namespace); }
  private captureMemoryMutationJobs(namespace: string): SemanticJobRow[] { return this.#context.captureMemoryMutationJobs(namespace); }
  private hasLiveMemoryMutationFence(namespace: string): boolean { return this.#context.hasLiveMemoryMutationFence(namespace); }
  private verifySnapshotVectorCoverage(projectId: number, generationId: number, namespace: string): Promise<number> { return this.#context.verifySnapshotVectorCoverage(projectId, generationId, namespace); }
  private memorySourceRows(scope: 'project' | 'user', projectId: number): AgentMemoryRow[] { return this.#context.memorySourceRows(scope, projectId); }
  private verifyMemoryVectorCoverage(scope: 'project' | 'user', projectId: number, generationId: number, namespace: string): Promise<number> { return this.#context.verifyMemoryVectorCoverage(scope, projectId, generationId, namespace); }
  private verifyMemoryItems(generationId: number, namespace: string, expected: ReadonlyMap<string, string>, label: string): Promise<number> { return this.#context.verifyMemoryItems(generationId, namespace, expected, label); }
  private verifyPhysicalVectorIds(namespace: string, generationId: number, expectedIds: readonly string[]): Promise<void> { return this.#context.verifyPhysicalVectorIds(namespace, generationId, expectedIds); }
  private completeNamespace(namespace: string, generationId: number, jobId: number, indexed: number, expected: number, previousActiveGenerationId: number | null): Promise<void> { return this.#context.completeNamespace(namespace, generationId, jobId, indexed, expected, previousActiveGenerationId); }
  private cleanupGenerationIfUnreferenced(namespace: string, generationId: number | null): Promise<void> { return this.#context.cleanupGenerationIfUnreferenced(namespace, generationId); }
  private pauseNamespace(namespace: string, jobId: number, error: unknown): void { return this.#context.pauseNamespace(namespace, jobId, error); }
  private refreshGenerationProgress(generationId: number): void { return this.#context.refreshGenerationProgress(generationId); }
  private serial(namespace: string, operation: () => Promise<void>, allowProjectRemoval?: boolean): Promise<void> { return this.#context.serial(namespace, operation, allowProjectRemoval); }
}
