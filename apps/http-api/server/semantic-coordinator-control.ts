import {
codeNamespace
} from '@mcp/shared/vector-namespace.js';
import { projectSemanticFolders } from '@mcp/shared/utils/semantic-folders.js';
import {
type SemanticJobRow,
type SemanticPurpose,
type SemanticStore
} from '@mcp/store';
import { errorMessage,MUTATION_FENCE_RECOVERY_PREFIXES,projectIdFromSemanticNamespace,type ReindexResult } from './semantic-coordinator-shared.js';

import type { SemanticCoordinatorContext } from './semantic-coordinator-context.js';

export const operations = {
listJobsOffThread(this: SemanticCoordinatorContext, filter: Parameters<SemanticStore['listJobs']>[0]): Promise<SemanticJobRow[]> {
    return this.deps.listJobsOffThread
      ? this.deps.listJobsOffThread(filter)
      : Promise.resolve(this.deps.semanticStore.listJobs(filter));
  },

recoverMutationFencesLocallyFailFast(this: SemanticCoordinatorContext): void {
    const recover = (): void => {
      this.deps.semanticStore.recoverNamespaceMutationFences?.(
        'docs:c',
        this.docsMutationOwner,
      );
      this.recoverExpiredMemoryMutationFences();
    };
    if (typeof this.deps.semanticStore.withBusyTimeout === 'function') {
      this.deps.semanticStore.withBusyTimeout(0, recover);
    } else {
      recover();
    }
  },

startMutationFenceRecovery(this: SemanticCoordinatorContext): Promise<void> {
    const recover = this.deps.recoverMutationFences;
    if (!recover) return Promise.resolve();
    const raw = recover(
      MUTATION_FENCE_RECOVERY_PREFIXES,
      this.memoryMutationOwner,
    ).then((recovered) => {
      if (recovered === null) this.recoverMutationFencesLocallyFailFast();
    });
    const guarded = raw.catch((error) => {
      if (this.mutationFenceRecovery === guarded) this.mutationFenceRecovery = null;
      console.warn(`[semantic] mutation-fence recovery deferred: ${errorMessage(error)}`);
      throw error;
    });
    this.mutationFenceRecovery = guarded;
    // Recovery begins eagerly at startup. Attach an observer so a worker
    // failure before the first semantic operation is not an unhandled
    // rejection; the operation itself will retry through the null slot.
    void guarded.catch(() => undefined);
    return guarded;
  },

ensureMutationFenceRecovery(this: SemanticCoordinatorContext): Promise<void> {
    if (!this.deps.recoverMutationFences) return Promise.resolve();
    return this.mutationFenceRecovery ?? this.startMutationFenceRecovery();
  },

allowsNamespaceMutation(this: SemanticCoordinatorContext, namespace: string): boolean {
    if (this.disposed) return false;
    const projectId = projectIdFromSemanticNamespace(namespace);
    return projectId === null
      || (!this.projectTombstones.has(projectId)
        && !(this.deps.semanticStore as SemanticStore & {
          hasProjectRemovalRequest?: SemanticStore['hasProjectRemovalRequest'];
        }).hasProjectRemovalRequest?.(projectId)
        && !!this.deps.db.getProject(projectId));
  },

reindex(this: SemanticCoordinatorContext, purpose: SemanticPurpose, force = true): Promise<ReindexResult> {
    if (this.disposed) return Promise.reject(new Error('Semantic coordinator is shutting down'));
    if (this.embeddingDisabled(purpose)) return Promise.resolve(this.disabledResult(purpose));
    const running = this.purposeRuns.get(purpose);
    if (running) return running;
    const run = this.runPurpose(purpose, force).finally(() => this.purposeRuns.delete(purpose));
    this.purposeRuns.set(purpose, run);
    return run;
  },

activateCodeProject(this: SemanticCoordinatorContext, projectId: number, leaseId = 'editor'): SemanticJobRow | null {
    if (this.disposed) return null;
    const project = this.deps.db.getProject(projectId);
    if (!project || project.is_synthetic) return null;
    const leases = this.codeProjectLeases.get(projectId) ?? new Set<string>();
    leases.add(leaseId);
    this.codeProjectLeases.set(projectId, leases);
    this.codePauseRequested.delete(projectId);
    if (!projectSemanticFolders(project).length) return null;
    const target = this.deps.semanticStore.getProjectTargets?.(projectId)?.embedding_target
      ?? this.deps.semanticStore.getProfile('code')?.embedding_target;
    if (target?.kind !== 'onnx' && target?.kind !== 'local_http') return null;
    const namespace = codeNamespace(projectId);
    const state = this.deps.semanticStore.listNamespaceGenerations({ namespace })[0];
    if (state?.active_generation_id && !state.building_generation_id) {
      const pendingDelta = this.deps.semanticStore.listJobs({ namespace, statuses: ['pending', 'paused', 'running'], kinds: ['delta', 'backfill'] }).find((job) =>
        (job.kind === 'delta' || (job.kind === 'backfill' && job.cursor?.reason === 'code-delta'))
        && (job.status === 'pending' || job.status === 'paused' || job.status === 'running'));
      if (pendingDelta) {
        queueMicrotask(() => void this.catchUpCodeProject(projectId).catch((error) =>
          console.warn(`[semantic] code delta catch-up paused for p${projectId}: ${errorMessage(error)}`)));
      }
      // The active generation is immediately usable. A clean reopen creates
      // no synthetic build marker and performs no all-files candidate pass.
      return pendingDelta ?? null;
    }
    return this.enqueueCodeProjectReindex(projectId, false, 'automatic-local-project-open');
  },

deactivateCodeProject(this: SemanticCoordinatorContext, projectId: number, leaseId = 'editor'): boolean {
    const leases = this.codeProjectLeases.get(projectId);
    if (leases) {
      leases.delete(leaseId);
      if (leases.size > 0) return false;
      this.codeProjectLeases.delete(projectId);
    }
    this.codePauseRequested.add(projectId);
    return true;
  },

acquireCodeProjectLease(this: SemanticCoordinatorContext, projectId: number, leaseId: string): () => void {
    this.activateCodeProject(projectId, `agent:${leaseId}`);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.deactivateCodeProject(projectId, `agent:${leaseId}`);
    };
  },

pauseJob(this: SemanticCoordinatorContext, jobId: number): SemanticJobRow {
    const job = this.deps.semanticStore.getJob(jobId);
    if (!job) throw new Error(`Semantic job ${jobId} not found`);
    const projectId = this.codeProjectIdForJob(job);
    if (projectId === null) throw new Error(`Semantic job ${jobId} does not support cooperative pause`);
    this.codePauseRequested.add(projectId);
    return this.deps.semanticStore.updateJob(job.id, {
      status: 'paused',
      cursor: { ...(job.cursor ?? {}), pause_requested: true },
      error: 'paused by user',
    }) ?? job;
  },

resumeJob(this: SemanticCoordinatorContext, jobId: number): SemanticJobRow {
    const job = this.deps.semanticStore.getJob(jobId);
    if (!job) throw new Error(`Semantic job ${jobId} not found`);
    const projectId = this.codeProjectIdForJob(job);
    if (projectId === null) throw new Error(`Semantic job ${jobId} does not support resume`);
    if (job.generation_id !== null && !this.jobGenerationIsReferenced(job)) {
      throw new Error(`Semantic job ${jobId} was superseded by a newer generation`);
    }
    this.codePauseRequested.delete(projectId);
    return this.enqueueCodeProjectReindex(
      projectId,
      job.cursor?.force === true,
      'explicit-project-resume',
    );
  }
};
