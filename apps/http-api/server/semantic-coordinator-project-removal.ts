import {
codeNamespace,
projectMemoryNamespace,
snapshotNamespace
} from '@mcp/shared/vector-namespace.js';
import {
projectIdFromRemovalNamespace,
projectRemovalNamespace,
type SemanticJobRow,
type SemanticStore
} from '@mcp/store';
import { errorMessage,PROJECT_REMOVAL_RETRY_MS,projectRemovalKind,type ProjectRemovalOptions } from './semantic-coordinator-shared.js';

import type { SemanticCoordinatorContext } from './semantic-coordinator-context.js';

export const operations = {
removeProject(this: SemanticCoordinatorContext, projectId: number, options: ProjectRemovalOptions = {}): Promise<void> {
    const kind = projectRemovalKind(options);
    const running = this.projectRemovalRuns.get(projectId);
    if (running) {
      if (running.kind === kind) return running.promise;
      return Promise.reject(new Error(
        `Project ${projectId} semantic ${running.kind} is already running; cannot start ${kind}`,
      ));
    }
    const run = this.performProjectRemoval(projectId, options);
    const tracked = run.finally(() => {
      if (this.projectRemovalRuns.get(projectId)?.promise === tracked) {
        this.projectRemovalRuns.delete(projectId);
      }
    });
    this.projectRemovalRuns.set(projectId, { kind, promise: tracked });
    return tracked;
  },

async performProjectRemoval(this: SemanticCoordinatorContext,
    projectId: number,
    options: ProjectRemovalOptions,
  ): Promise<void> {
    const namespaces = [
      codeNamespace(projectId),
      snapshotNamespace(projectId),
      projectMemoryNamespace(projectId),
    ];
    const markerNamespace = projectRemovalNamespace(projectId);
    // Removal must publish its tombstone before yielding to another writer.
    const existingMarker = this.deps.semanticStore.listJobs({ namespace: markerNamespace, kinds: ['cleanup'] })
      .find((job) => job.kind === 'cleanup' && job.cursor?.reason === 'project-removal');
    // Older test doubles do not expose requestProjectRemoval; the fallback is
    // intentionally confined to coordinator-local callers.
    const requestRemoval = (this.deps.semanticStore as SemanticStore & {
      requestProjectRemoval?: SemanticStore['requestProjectRemoval'];
    }).requestProjectRemoval;
    const marker = existingMarker ?? (requestRemoval
      ? requestRemoval.call(this.deps.semanticStore, {
          projectId,
          requestedBy: 'server',
          finalizeProject: !!options.finalize && !options.retainProject,
        })
      : this.deps.semanticStore.createJob({
          generation_id: null,
          namespace: markerNamespace,
          kind: 'cleanup',
          priority: 100,
          expected_items: 1,
          cursor: { reason: 'project-removal', projectId },
        }));
    const finalizeProject = marker.cursor?.finalize_project === true
      || (!!options.finalize && !options.retainProject);
    this.deps.semanticStore.updateJob(marker.id, {
      status: 'running', processed_items: 0, failed_items: 0, error: null,
      cursor: {
        ...(marker.cursor ?? {}),
        reason: 'project-removal',
        projectId,
        finalize_project: finalizeProject,
      },
    });
    this.projectTombstones.add(projectId);

    const removeWhileStructurallyIdle = async (): Promise<void> => {
      let release!: () => void;
      const released = new Promise<void>((resolve) => { release = resolve; });
      const entered = namespaces.map(() => {
        let resolve!: () => void;
        const promise = new Promise<void>((done) => { resolve = done; });
        return { promise, resolve };
      });
      // Enter only after each existing namespace tail drains, then retain all
      // three locks until the worker removes vectors.db and control-plane rows.
      const barriers = namespaces.map((namespace, index) => this.serial(namespace, async () => {
        entered[index].resolve();
        await released;
      }, true));

      try {
        await Promise.all(entered.map((gate) => gate.promise));
        if (this.deps.db.getProject(projectId)) {
          await this.workerRemoveProject(projectId);
        } else {
          // removeProject is ordered before catalog deletion. If the row is
          // already absent, a previous physical pass succeeded; only finish an
          // idempotent control-plane cleanup without resolving a new DB path.
          for (const namespace of namespaces) this.deps.semanticStore.deleteNamespace(namespace);
        }
        await options.finalize?.();
        this.deps.semanticStore.updateJob(marker.id, {
          status: options.retainProject ? 'cancelled' : 'completed',
          processed_items: 1,
          failed_items: 0,
          error: null,
        });
        if (options.retainProject) this.projectTombstones.delete(projectId);
      } catch (error) {
        this.deps.semanticStore.updateJob(marker.id, {
          status: 'paused', failed_items: 1, error: errorMessage(error),
        });
        throw error;
      } finally {
        release();
        await Promise.allSettled(barriers);
      }
    };

    if (this.deps.withProjectLock) {
      await this.deps.withProjectLock(projectId, removeWhileStructurallyIdle);
    } else {
      await removeWhileStructurallyIdle();
    }
  },

recoverInterruptedJobsPassively(this: SemanticCoordinatorContext): void {
    for (const job of this.deps.semanticStore.listJobs({
      statuses: ['pending', 'running', 'paused'],
    })) {
      const open = job.status === 'pending' || job.status === 'running' || job.status === 'paused';
      if (open
        && job.generation_id !== null
        && (job.kind === 'backfill' || job.kind === 'build')
        && !this.jobGenerationIsReferenced(job)) {
        this.deps.semanticStore.updateJob(job.id, {
          status: 'cancelled',
          error: 'superseded by a newer active or building generation',
        });
        continue;
      }
      if (job.status !== 'running') continue;
      if (job.kind === 'cleanup' || job.cursor?.reason === 'mutation-fence') continue;
      this.deps.semanticStore.updateJob(job.id, {
        status: 'paused',
        processed_items: 0,
        error: 'interrupted by application restart; waiting for an explicit resume',
      });
    }
  },

jobGenerationIsReferenced(this: SemanticCoordinatorContext, job: SemanticJobRow): boolean {
    if (job.generation_id === null) return true;
    const state = this.deps.semanticStore.listNamespaceGenerations({ namespace: job.namespace })[0];
    return state?.active_generation_id === job.generation_id
      || state?.building_generation_id === job.generation_id;
  },

dispose(this: SemanticCoordinatorContext): Promise<void> {
    return this.disposal ??= this.drainForDisposal();
  },

async drainForDisposal(this: SemanticCoordinatorContext): Promise<void> {
    this.disposed = true;
    if (this.docsBackfillTimer) clearTimeout(this.docsBackfillTimer);
    this.docsBackfillTimer = null;
    if (this.projectRemovalRetryTimer) clearTimeout(this.projectRemovalRetryTimer);
    this.projectRemovalRetryTimer = null;
    for (const timer of this.codeDeltaRetryTimers.values()) clearTimeout(timer);
    this.codeDeltaRetryTimers.clear();
    this.pendingCodeDeltas.clear();
    this.pendingCodeDeltaPreviousKeys.clear();
    this.codeDeltaRetryAttempts.clear();
    // The owned SQLite connection is closed immediately after this resolves.
    // Include terminal job writes, not only the embedding/build promise, and
    // re-sample because already-owned work may enqueue a final cleanup tail.
    const observed = new Set<Promise<unknown>>();
    for (;;) {
      const candidates: Array<Promise<unknown> | null | undefined> = [this.docsBackfillRun, this.projectRemovalRecoveryRun,
        this.mutationFenceRecovery, this.codeBuildTail, ...this.locks.values(),
        ...this.codeCatchupRuns.values(), ...this.projectReindexRuns.values(),
        ...this.projectReindexDispatches.values(), ...this.purposeRuns.values(),
        ...this.generationRuns.values(), ...this.cleanupRuns.values(),
        ...this.unusedVectorCleanupRuns.values(), ...[...this.projectRemovalRuns.values()].map(run => run.promise),
      ];
      const pending = candidates.filter((run): run is Promise<unknown> => !!run && !observed.has(run));
      if (!pending.length) return;
      for (const run of pending) observed.add(run);
      await Promise.allSettled(pending);
    }
  },

recoverExpiredMemoryMutationFences(this: SemanticCoordinatorContext, now = Date.now()): number {
    return [
      'snapshot:p',
      'memory:project:p',
      'memory:user',
    ].reduce((total, prefix) => total + this.deps.semanticStore.recoverNamespaceMutationFences(
      prefix,
      this.memoryMutationOwner,
      now,
    ), 0);
  },

retryPendingProjectRemovals(this: SemanticCoordinatorContext): Promise<number> {
    if (this.projectRemovalRecoveryRun) return this.projectRemovalRecoveryRun;
    const run = this.drainPendingProjectRemovals().finally(() => {
      if (this.projectRemovalRecoveryRun === run) this.projectRemovalRecoveryRun = null;
    });
    this.projectRemovalRecoveryRun = run;
    return run;
  },

scheduleProjectRemovalRetry(this: SemanticCoordinatorContext, delayMs = PROJECT_REMOVAL_RETRY_MS): void {
    if (this.disposed || this.projectRemovalRetryTimer) return;
    this.projectRemovalRetryTimer = setTimeout(() => {
      this.projectRemovalRetryTimer = null;
      void this.retryPendingProjectRemovals()
        .catch((error) => console.warn(`[semantic] project removal retry paused: ${errorMessage(error)}`))
        .finally(() => this.scheduleProjectRemovalRetry(PROJECT_REMOVAL_RETRY_MS));
    }, Math.max(1, delayMs));
    this.projectRemovalRetryTimer.unref?.();
  },

async drainPendingProjectRemovals(this: SemanticCoordinatorContext): Promise<number> {
    let completed = 0;
    const requests = (await this.listJobsOffThread({
      statuses: ['pending', 'paused', 'running'],
      kinds: ['cleanup'],
    })).filter((job) =>
      job.kind === 'cleanup'
      && job.cursor?.reason === 'project-removal'
      && job.cursor?.finalize_project === true
      && (job.status === 'pending' || job.status === 'paused' || job.status === 'running')
    );
    for (const request of requests) {
      const projectId = projectIdFromRemovalNamespace(request.namespace);
      if (projectId === null) continue;
      const project = this.deps.db.getProject(projectId);
      if (!project) {
        this.deps.semanticStore.updateJob(request.id, {
          status: 'completed', processed_items: 1, failed_items: 0, error: null,
        });
        this.projectTombstones.add(projectId);
        completed++;
        continue;
      }
      try {
        await this.removeProject(projectId, {
          finalize: () => this.deps.db.deleteProject(projectId),
        });
        completed++;
      } catch {
        // performProjectRemoval classifies the durable marker as paused. The
        // periodic sweep retries without making the half-removed project lie.
      }
    }
    return completed;
  }
};
