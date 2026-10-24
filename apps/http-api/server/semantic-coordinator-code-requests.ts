import {
EmbeddingPauseRequestedError
} from '@mcp/indexer/indexer/indexer/embed-retry.js';
import {
codeNamespace
} from '@mcp/shared/vector-namespace.js';
import {
type SemanticGenerationRow,
type SemanticJobRow
} from '@mcp/store';
import { errorMessage,readCodeDeltaCursor,type ReindexResult } from './semantic-coordinator-shared.js';

import type { SemanticCoordinatorContext } from './semantic-coordinator-context.js';

export const operations = {
ensureCodeProject(this: SemanticCoordinatorContext, projectId: number): Promise<void> {
    return this.coalesceCodeCatchup(projectId, async () => {
      const generation = await this.ensureGeneration('code', false);
      await this.runCodeProjectBuild(projectId, generation, false);
    });
  },

catchUpCodeProject(this: SemanticCoordinatorContext, projectId: number): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.embeddingDisabled('code')) return Promise.resolve();
    const namespace = codeNamespace(projectId);
    const state = this.deps.semanticStore.listNamespaceGenerations({ namespace })[0];
    const generationId = state?.building_generation_id ?? state?.active_generation_id;
    if (!generationId) return Promise.resolve();
    const requiresExplicitSweep = this.deps.semanticStore.listJobs({ namespace, statuses: ['pending', 'paused', 'running'], kinds: ['delta', 'backfill'] }).some((job) => {
      if ((job.status !== 'pending' && job.status !== 'paused' && job.status !== 'running')
        || (job.kind !== 'delta' && job.kind !== 'backfill')
        || job.cursor?.reason !== 'code-delta') return false;
      const events = readCodeDeltaCursor(job.cursor).events;
      // A legacy cursor without paths has the same uncertainty as an
      // overflow wildcard. Never turn either into a surprise whole-project
      // sweep from project-open/watcher catch-up.
      return events.length === 0 || events.some((event) => event.path === '*');
    });
    // Unknown-path invalidations from a stat-first reopen are allowed to run
    // only while this project owns an editor/agent lease. They perform a
    // bounded hash-aware sweep (unchanged candidates are not embedded) rather
    // than turning a background mutation into a surprise whole-project job.
    if (requiresExplicitSweep && (this.codeProjectLeases.get(projectId)?.size ?? 0) === 0) {
      return Promise.resolve();
    }
    const generation = this.deps.semanticStore.getGeneration(generationId);
    if (!generation) return Promise.resolve();
    return this.coalesceCodeCatchup(projectId, () =>
      this.runCodeProjectBuild(projectId, generation, false));
  },

reindexCodeProject(this: SemanticCoordinatorContext, projectId: number, force = true): Promise<ReindexResult> {
    if (this.disposed) return Promise.reject(new Error('Semantic coordinator is shutting down'));
    const project = this.deps.db.getProject(projectId);
    if (!project || project.is_synthetic) {
      return Promise.reject(new Error(`Project ${projectId} not found`));
    }
    if (this.embeddingDisabled('code')) return Promise.resolve(this.disabledResult('code'));
    const running = this.projectReindexRuns.get(projectId);
    if (running) return running;
    const run = (async (): Promise<ReindexResult> => {
      const generation = await this.ensureGeneration('code', force);
      try {
        await this.coalesceCodeCatchup(projectId, () =>
          this.runCodeProjectBuild(projectId, generation, false));
        return {
          purpose: 'code',
          generation_id: generation.id,
          completed_namespaces: [codeNamespace(projectId)],
          failed_namespaces: [],
        };
      } catch (error) {
        if (error instanceof EmbeddingPauseRequestedError) throw error;
        return {
          purpose: 'code',
          generation_id: generation.id,
          completed_namespaces: [],
          failed_namespaces: [{ namespace: codeNamespace(projectId), error: errorMessage(error) }],
        };
      }
    })();
    const tracked = run.finally(() => {
      if (this.projectReindexRuns.get(projectId) === tracked) this.projectReindexRuns.delete(projectId);
    });
    this.projectReindexRuns.set(projectId, tracked);
    return tracked;
  },

enqueueCodeProjectReindex(this: SemanticCoordinatorContext,
    projectId: number,
    force = true,
    reason = 'explicit-project-reindex',
  ): SemanticJobRow {
    if (this.disposed) throw new Error('Semantic coordinator is shutting down');
    const project = this.deps.db.getProject(projectId);
    if (!project || project.is_synthetic) throw new Error(`Project ${projectId} not found`);
    const markerNamespace = `semantic:reindex:code:p${projectId}`;
    const existing = this.deps.semanticStore.listJobs({ namespace: markerNamespace,
      kinds: ['build'], statuses: ['pending', 'running', 'paused'], limit: 1 })[0];
    let job: SemanticJobRow;
    if (existing) {
      const preserveExplicit = existing.cursor?.reason === 'explicit-project-reindex'
        || existing.cursor?.reason === 'explicit-project-resume';
      const effectiveForce = preserveExplicit && reason.startsWith('automatic-')
        ? existing.cursor?.force !== false
        : force;
      job = this.deps.semanticStore.updateJob(existing.id, {
        ...(existing.status === 'running' ? {} : { status: 'pending' as const }),
        cursor: {
          ...(existing.cursor ?? {}),
          reason: preserveExplicit ? existing.cursor?.reason : reason,
          project_id: projectId,
          force: effectiveForce,
          pause_requested: false,
        },
        expected_items: this.deps.db.countFiles(projectId),
        ...(existing.status === 'running' ? {} : { processed_items: 0, failed_items: 0, error: null }),
      }) ?? existing;
    } else {
      job = this.deps.semanticStore.createJob({
        generation_id: null,
        namespace: markerNamespace,
        kind: 'build',
        priority: reason.startsWith('automatic-') ? 20 : 100,
        cursor: { reason, project_id: projectId, force, pause_requested: false },
        expected_items: this.deps.db.countFiles(projectId),
      });
    }
    if (job.status !== 'running') queueMicrotask(() => this.dispatchCodeProjectReindex(projectId, job.id));
    return job;
  },

dispatchCodeProjectReindex(this: SemanticCoordinatorContext, projectId: number, jobId: number): void {
    if (this.disposed || this.projectReindexDispatches.has(projectId)) return;
    const run = (async () => {
      const current = this.deps.semanticStore.getJob(jobId);
      if (!current || (current.status !== 'pending' && current.status !== 'paused')) return;
      this.deps.semanticStore.updateJob(jobId, {
        status: 'running', processed_items: 0, failed_items: 0, error: null,
      });
      try {
        const result = await this.reindexCodeProject(projectId, current.cursor?.force !== false);
        if (result.failed_namespaces.length > 0) {
          throw new Error(result.failed_namespaces.map((row) => `${row.namespace}: ${row.error}`).join('; '));
        }
        this.deps.semanticStore.updateJob(jobId, {
          status: 'completed',
          cursor: { ...(current.cursor ?? {}), result },
          processed_items: current.expected_items,
          failed_items: 0,
          error: null,
        });
      } catch (error) {
        const paused = error instanceof EmbeddingPauseRequestedError
          || errorMessage(error).includes('semantic backfill paused');
        this.deps.semanticStore.updateJob(jobId, {
          status: 'paused',
          failed_items: paused ? current.failed_items : current.failed_items + 1,
          error: paused ? 'paused because project is not active' : errorMessage(error),
        });
      }
    })();
    const tracked = run.finally(() => {
      if (this.projectReindexDispatches.get(projectId) === tracked) {
        this.projectReindexDispatches.delete(projectId);
      }
    });
    this.projectReindexDispatches.set(projectId, tracked);
    void tracked.catch(error => console.warn(`[semantic] project reindex dispatch failed: ${errorMessage(error)}`));
  },

coalesceCodeCatchup(this: SemanticCoordinatorContext, projectId: number, operation: () => Promise<void>): Promise<void> {
    const namespace = codeNamespace(projectId);
    if (this.embeddingDisabled('code') || !this.allowsNamespaceMutation(namespace)) return Promise.resolve();
    const running = this.codeCatchupRuns.get(namespace);
    if (running) return running;
    const build = () => this.serial(namespace, async () => {
      if (this.embeddingDisabled('code') || !this.allowsNamespaceMutation(namespace)) return;
      await operation();
    });
    const run = this.deps.withProjectLock
      ? this.deps.withProjectLock(projectId, build)
      : build();
    const tracked = run.finally(() => {
      if (this.codeCatchupRuns.get(namespace) === tracked) this.codeCatchupRuns.delete(namespace);
    });
    this.codeCatchupRuns.set(namespace, tracked);
    return tracked;
  },

async runCodeProjectBuild(this: SemanticCoordinatorContext,
    projectId: number,
    generation: SemanticGenerationRow,
    force: boolean,
  ): Promise<void> {
    const run = this.codeBuildTail.catch(() => undefined).then(async () => {
      if (this.shouldPauseCodeProject(projectId)) throw new EmbeddingPauseRequestedError();
      try {
        await this.buildCodeNamespace(projectId, generation, force);
      } finally {
        this.refreshGenerationProgress(generation.id);
      }
    });
    this.codeBuildTail = run;
    return run;
  },

shouldPauseCodeProject(this: SemanticCoordinatorContext, projectId: number): boolean {
    return this.disposed || this.codePauseRequested.has(projectId)
      && (this.codeProjectLeases.get(projectId)?.size ?? 0) === 0;
  },

codeProjectIdForJob(this: SemanticCoordinatorContext, job: SemanticJobRow): number | null {
    const cursorProjectId = Number(job.cursor?.project_id);
    if (Number.isSafeInteger(cursorProjectId) && cursorProjectId > 0) return cursorProjectId;
    const match = /^(?:code:p|semantic:reindex:code:p)(\d+)$/.exec(job.namespace);
    return match ? Number(match[1]) : null;
  },

semanticProjectIdForJob(this: SemanticCoordinatorContext, job: SemanticJobRow): number | null {
    const codeProjectId = this.codeProjectIdForJob(job);
    if (codeProjectId !== null) return codeProjectId;
    const match = /^(?:snapshot:p|memory:project:p)(\d+)$/.exec(job.namespace);
    return match ? Number(match[1]) : null;
  }
};
