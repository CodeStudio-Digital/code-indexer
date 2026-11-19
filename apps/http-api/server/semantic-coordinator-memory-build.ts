import {
projectMemoryNamespace,
snapshotNamespace,
userMemoryNamespace
} from '@mcp/shared/vector-namespace.js';
import {
type SemanticGenerationRow,
type SemanticJobRow
} from '@mcp/store';
import { DeltaBuildPendingError,errorMessage } from './semantic-coordinator-shared.js';

import type { SemanticCoordinatorContext } from './semantic-coordinator-context.js';

export const operations = {
async buildSnapshotNamespace(this: SemanticCoordinatorContext, projectId: number, generation: SemanticGenerationRow, force: boolean): Promise<void> {
    const namespace = snapshotNamespace(projectId);
    this.assertNamespaceProjectActive(namespace);
    for (let pass = 0; pass < 3; pass++) {
      if (this.hasLiveMemoryMutationFence(namespace)) {
        throw new DeltaBuildPendingError(namespace);
      }
      const before = this.deps.semanticStore.listNamespaceGenerations({ namespace })[0];
      const captured = this.captureMemoryMutationJobs(namespace);
      if (!force
        && before?.active_generation_id === generation.id
        && before.delta_items === 0
        && captured.length === 0) return;
      const total = this.deps.db.listSnapshotsForSemanticIndex(projectId).length;
      const activating = before?.active_generation_id !== generation.id;
      if (activating) this.prepareNamespaceGeneration(namespace, 'memory', generation.id, total);
      const job = this.deps.semanticStore.claimBuildJob({
        generation_id: generation.id,
        namespace,
        kind: before?.active_generation_id ? 'build' : 'backfill',
        expected_items: total,
      });
      if (!job) throw new DeltaBuildPendingError(namespace);
      try {
        const result = await this.deps.snapshotService.backfillEmbeddings(projectId);
        if (result.failed > 0) throw new Error(`snapshot embedding failed for ${result.failed}/${result.total} source(s)`);
        const indexed = await this.verifySnapshotVectorCoverage(projectId, generation.id, namespace);
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

async buildMemoryNamespace(this: SemanticCoordinatorContext,
    scope: 'project' | 'user',
    projectId: number,
    generation: SemanticGenerationRow,
    force: boolean,
  ): Promise<void> {
    const namespace = scope === 'user' ? userMemoryNamespace() : projectMemoryNamespace(projectId);
    this.assertNamespaceProjectActive(namespace);
    for (let pass = 0; pass < 3; pass++) {
      if (this.hasLiveMemoryMutationFence(namespace)) {
        throw new DeltaBuildPendingError(namespace);
      }
      const before = this.deps.semanticStore.listNamespaceGenerations({ namespace })[0];
      const captured = this.captureMemoryMutationJobs(namespace);
      if (!force
        && before?.active_generation_id === generation.id
        && before.delta_items === 0
        && captured.length === 0) return;
      const activating = before?.active_generation_id !== generation.id;
      const targetedKeys = !force && !activating
        ? this.targetedMemoryMutationKeys(captured)
        : null;
      const investigationRows = targetedKeys === null && scope === 'project'
        ? await this.deps.investigationSemanticIndex.listProject(projectId)
        : [];
      const total = targetedKeys === null
        ? this.memorySourceRows(scope, projectId).length + investigationRows.length
        : targetedKeys.length;
      if (activating) this.prepareNamespaceGeneration(namespace, 'memory', generation.id, total);
      const job = this.deps.semanticStore.claimBuildJob({
        generation_id: generation.id,
        namespace,
        kind: before?.active_generation_id ? 'build' : 'backfill',
        expected_items: total,
        ...(targetedKeys === null ? {} : {
          cursor: {
            reason: 'targeted-memory-delta',
            item_keys: targetedKeys,
          },
        }),
      });
      if (!job) throw new DeltaBuildPendingError(namespace);
      try {
        if (targetedKeys !== null) {
          const delta = await this.reconcileTargetedMemoryMutation(
            scope,
            projectId,
            generation,
            namespace,
            targetedKeys,
          );
          const finish = this.deps.semanticStore.finishNamespaceMutationPass({
            namespace,
            generation_id: generation.id,
            expected_items: delta.namespaceItems,
            indexed_items: delta.namespaceItems,
            captured_jobs: captured.map((entry) => ({
              id: entry.id,
              expected_items: entry.expected_items,
            })),
            activate: false,
          });
          this.deps.semanticStore.updateJob(job.id, {
            status: 'completed',
            processed_items: delta.processedKeys,
            failed_items: 0,
            error: null,
          });
          if (finish.pending) {
            if (pass < 2) continue;
            throw new DeltaBuildPendingError(namespace);
          }
          return;
        }

        const result = await this.deps.agentMemoryService.backfillEmbeddings(
          projectId,
          Math.max(total, 1),
          scope,
        );
        const investigationResult = scope === 'project'
          ? await this.deps.investigationSemanticIndex.backfillProject(projectId)
          : { embedded: 0, failed: 0, skipped: 0, total: 0 };
        this.deps.semanticStore.updateJob(job.id, {
          processed_items: result.embedded + result.skipped
            + investigationResult.embedded + investigationResult.skipped,
          failed_items: result.failed + investigationResult.failed,
        });
        const failed = result.failed + investigationResult.failed;
        if (failed > 0) throw new Error(`memory embedding failed for ${failed}/${total} source(s)${result.error ? `: ${result.error}` : ''}`);
        const indexed = await this.verifyMemoryVectorCoverage(scope, projectId, generation.id, namespace);
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

targetedMemoryMutationKeys(this: SemanticCoordinatorContext, captured: readonly SemanticJobRow[]): string[] | null {
    if (captured.length === 0) return null;
    const keys = new Set<string>();
    for (const job of captured) {
      if (
        job.cursor?.item_keys_truncated === true
        || job.cursor?.requires_explicit_reindex === true
      ) return null;
      const itemKeys = job.cursor?.item_keys;
      if (!Array.isArray(itemKeys)) return null;
      for (const itemKey of itemKeys) {
        if (typeof itemKey !== 'string'
          || itemKey === '*'
          || !/^(?:agent_memory|investigation):\d+$/.test(itemKey)) return null;
        keys.add(itemKey);
      }
    }
    return [...keys];
  }
};
