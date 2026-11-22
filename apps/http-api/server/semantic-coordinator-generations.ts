import { NullEmbeddingService } from '@mcp/indexer/search/embeddings.js';
import { projectSemanticFolders } from '@mcp/shared/utils/semantic-folders.js';
import {
codeNamespace,
docNamespace,
projectMemoryNamespace,
snapshotNamespace,
userMemoryNamespace,
} from '@mcp/shared/vector-namespace.js';
import {
embeddingTargetsEqual,
type SemanticGenerationRow,
type SemanticJobRow,
type SemanticPurpose
} from '@mcp/store';
import {
generationMatchesEmbeddingFingerprint
} from '@mcp/store/vectors.js';
import { errorMessage,projectIdFromSemanticNamespace,SemanticVectorWorkerUnavailableError, StructuralWorkPendingError, type ReindexResult } from './semantic-coordinator-shared.js';

import type { SemanticCoordinatorContext } from './semantic-coordinator-context.js';

export const operations = {
async runPurpose(this: SemanticCoordinatorContext, purpose: SemanticPurpose, force: boolean): Promise<ReindexResult> {
    if (this.embeddingDisabled(purpose)) return this.disabledResult(purpose);
    const codeProjects = purpose === 'code'
      ? this.deps.db.listProjects().filter((project) => !project.is_synthetic && projectSemanticFolders(project).length
        && !this.deps.semanticStore.getProjectTargets?.(project.id))
      : [];
    if (purpose === 'code' && !codeProjects.length) return this.disabledResult(purpose);
    const generation = await this.ensureGeneration(purpose, force);
    const completed: string[] = [];
    const failed: Array<{ namespace: string; error: string }> = [];
    const run = async (namespace: string, build: () => Promise<void>): Promise<void> => {
      if (!this.allowsNamespaceMutation(namespace)) return;
      try {
        await this.serial(namespace, build);
        if (this.allowsNamespaceMutation(namespace)) completed.push(namespace);
      } catch (error) {
        if (error instanceof StructuralWorkPendingError) throw error;
        failed.push({ namespace, error: errorMessage(error) });
      }
    };

    if (purpose === 'code') {
      for (const project of codeProjects) {
        const build = () => run(
          codeNamespace(project.id),
          () => this.runCodeProjectBuild(project.id, generation, force),
        );
        await this.scheduleCodeBuild(project.id, build);
      }
    } else if (purpose === 'docs') {
      for (const collection of this.deps.docStore.listCollections()) {
        await run(docNamespace(collection.id), () => this.buildDocsNamespace(collection.id, generation, force));
      }
    } else {
      for (const project of this.deps.db.listProjects()) {
        if (project.is_synthetic) continue;
        await run(snapshotNamespace(project.id), () => this.buildSnapshotNamespace(project.id, generation, force));
        await run(projectMemoryNamespace(project.id), () => this.buildMemoryNamespace('project', project.id, generation, force));
      }
      await run(userMemoryNamespace(), () => this.buildMemoryNamespace('user', 0, generation, force));
    }

    this.refreshGenerationProgress(generation.id);
    return {
      purpose,
      generation_id: generation.id,
      completed_namespaces: completed,
      failed_namespaces: failed,
    };
  },

ensureGeneration(this: SemanticCoordinatorContext, purpose: SemanticPurpose, force: boolean, projectId?: number): Promise<SemanticGenerationRow> {
    const previous = this.generationRuns.get(purpose);
    const current = (previous ? previous.catch(() => undefined) : Promise.resolve())
      .then(() => this.resolveGeneration(purpose, force, projectId));
    const tracked = current.finally(() => {
      if (this.generationRuns.get(purpose) === tracked) this.generationRuns.delete(purpose);
    });
    this.generationRuns.set(purpose, tracked);
    return tracked;
  },

async resolveGeneration(this: SemanticCoordinatorContext, purpose: SemanticPurpose, force: boolean, projectId?: number): Promise<SemanticGenerationRow> {
    const namespace = projectId === undefined ? undefined : codeNamespace(projectId);
    const embedding = projectId === undefined ? this.embeddingForPurpose(purpose)
      : this.deps.codeEmbeddingForProject?.(projectId) ?? this.deps.codeEmbedding;
    if (embedding instanceof NullEmbeddingService || embedding.fingerprint?.() === 'null') {
      throw new Error(`${purpose} embedding profile is disabled`);
    }
    let workerAvailable = false;
    try { workerAvailable = await this.deps.vectorStore.isAvailable(); }
    catch { /* classified below; FTS remains the serving fallback */ }
    if (!workerAvailable
      || typeof this.deps.vectorStore.listIds !== 'function'
      || typeof this.deps.vectorStore.dropGeneration !== 'function') {
      throw new SemanticVectorWorkerUnavailableError('generation build');
    }
    const baseFingerprint = embedding.fingerprint?.() ?? `semantic:${purpose}:unknown`;
    const desiredTarget = () => (projectId === undefined ? undefined : this.deps.semanticStore.getProjectTargets?.(projectId)?.embedding_target)
      ?? this.deps.semanticStore.getProfile(purpose)?.embedding_target;
    const currentTarget = desiredTarget();
    if (!currentTarget) throw new Error(`Missing semantic profile: ${purpose}`);
    const compatible = this.deps.semanticStore.listGenerations({ purpose })
      .filter((generation) => generation.status === 'building' || generation.status === 'ready')
      .filter((generation) => generationMatchesEmbeddingFingerprint(
        generation.fingerprint,
        baseFingerprint,
      ) && embeddingTargetsEqual(generation.embedding_target, currentTarget));
    // Never abandon a compatible rollout halfway through. Even an explicit
    // reindex first completes its current namespace-by-namespace activation;
    // the next request may then create the replacement space.
    const compatibleBuilding = compatible.find((generation) => generation.status === 'building');
    if (compatibleBuilding) return compatibleBuilding;
    if (!force) {
      const existing = compatible[0];
      if (existing) return existing;
    }
    // A previous construction table or failed cleanup must be resolved before
    // probing/creating a new generation. A failed DROP deliberately leaves its
    // control-plane pointer/job in place, so retries cannot accumulate tables.
    await this.recoverPendingCleanupJobs(purpose, namespace);
    await this.recoverAbandonedBuildingGenerations(purpose, namespace);
    this.assertSingleActiveGenerationPerFile(purpose);
    const { vector } = await embedding.embedQuery('semantic generation dimension probe');
    const fingerprintAfterProbe = embedding.fingerprint?.() ?? `semantic:${purpose}:unknown`;
    const targetAfterProbe = desiredTarget();
    if (fingerprintAfterProbe !== baseFingerprint
      || JSON.stringify(targetAfterProbe) !== JSON.stringify(currentTarget)) {
      throw new Error(`${purpose} embedding profile changed during generation probe`);
    }
    if (!vector.length || vector.some((value) => !Number.isFinite(value))) {
      throw new Error(`${purpose} embedding dimension probe failed`);
    }
    // Dimension is part of the immutable generation identity even though the
    // reusable service fingerprint intentionally remains dimension-agnostic
    // until its first probe. Vector/item hashes still recover the service
    // fingerprint through embeddingFingerprintForGeneration().
    // Keep previous generations queryable. A fresh build records the document
    // layout independently of the embedding space used for query encoding.
    const layout = purpose === 'code' || purpose === 'docs' || currentTarget.kind === 'onnx' ? ':input-layout:v2' : '';
    const spaceFingerprint = `${baseFingerprint}${layout}:space-dimension:${vector.length}`;
    const fingerprint = force
      ? `${spaceFingerprint}:rebuild:${Date.now()}:${Math.random().toString(16).slice(2, 8)}`
      : spaceFingerprint;
    const generation = this.deps.semanticStore.createGeneration({
      purpose,
      fingerprint,
      embedding_target: currentTarget,
      dimension: vector.length,
    });
    // The probe validates only the vector space. `ready` is withheld until all
    // target namespaces pass their logical and physical coverage gates.
    return generation;
  },

assertSingleActiveGenerationPerFile(this: SemanticCoordinatorContext, purpose: SemanticPurpose): void {
    const activeByFile = new Map<string, Set<number>>();
    for (const row of this.deps.semanticStore.listNamespaceGenerations({ purpose })) {
      if (!row.active_generation_id) continue;
      try {
        const route = this.deps.router.resolve(row.namespace, row.active_generation_id);
        const key = `${route.dbPath.toLowerCase()}\0${purpose}`;
        const ids = activeByFile.get(key) ?? new Set<number>();
        ids.add(row.active_generation_id);
        activeByFile.set(key, ids);
      } catch {
        // Removed/unresolvable projects cannot gain a new table from this run.
      }
    }
    const incomplete = Array.from(activeByFile.entries()).find(([, ids]) => ids.size > 1);
    if (incomplete) {
      throw new Error(`${purpose} generation rollout is incomplete for ${incomplete[0].split('\0')[0]}`);
    }
  },

workerDropGeneration(this: SemanticCoordinatorContext, namespace: string, generationId: number): Promise<void> {
    const drop = this.deps.vectorStore.dropGeneration;
    if (!drop) throw new SemanticVectorWorkerUnavailableError('generation cleanup');
    return drop.call(this.deps.vectorStore, namespace, generationId);
  },

workerListIds(this: SemanticCoordinatorContext, namespace: string, generationId: number): Promise<string[]> {
    const list = this.deps.vectorStore.listIds;
    if (!list) throw new SemanticVectorWorkerUnavailableError('physical coverage probe');
    return list.call(this.deps.vectorStore, namespace, generationId);
  },

workerDeleteIds(this: SemanticCoordinatorContext,
    namespace: string,
    generationId: number,
    ids: string[],
  ): Promise<number> {
    const remove = this.deps.vectorStore.deleteByIdsForGeneration;
    if (!remove) throw new SemanticVectorWorkerUnavailableError('generation-scoped vector deletion');
    return remove.call(this.deps.vectorStore, namespace, generationId, ids);
  },

workerDeleteItemKeys(this: SemanticCoordinatorContext,
    namespace: string,
    generationId: number,
    itemKeys: string[],
  ): Promise<number> {
    const remove = this.deps.vectorStore.deleteByItemKeysForGeneration;
    if (!remove) throw new SemanticVectorWorkerUnavailableError('generation-scoped item deletion');
    return remove.call(this.deps.vectorStore, namespace, generationId, itemKeys);
  },

workerRemoveProject(this: SemanticCoordinatorContext, projectId: number): Promise<void> {
    const remove = this.deps.vectorStore.removeProject;
    if (!remove) throw new SemanticVectorWorkerUnavailableError('project vector removal');
    return remove.call(this.deps.vectorStore, projectId);
  },

async recoverPendingCleanupJobs(this: SemanticCoordinatorContext, purpose: SemanticPurpose, namespace?: string): Promise<void> {
    const jobs = (await this.listJobsOffThread({
      statuses: ['pending', 'paused', 'running'],
      kinds: ['cleanup'],
      ...(namespace ? { namespace } : {}),
    }))
      .filter((job) => job.kind === 'cleanup'
        && (job.status === 'pending' || job.status === 'paused' || job.status === 'running')
        && job.generation_id
        && this.deps.semanticStore.getGeneration(job.generation_id)?.purpose === purpose);
    for (const job of jobs) await this.performCleanupJob(job);
  },

async recoverAbandonedBuildingGenerations(this: SemanticCoordinatorContext, purpose: SemanticPurpose, namespace?: string): Promise<void> {
    const states = this.deps.semanticStore.listNamespaceGenerations({ purpose });
    const groups = new Map<string, {
      namespace: string;
      generationId: number;
      dbPath: string;
      tableName: string;
      namespaces: string[];
    }>();
    for (const state of states) {
      if (!state.building_generation_id) continue;
      if (namespace && state.namespace !== namespace) continue;
      const codeProjectId = purpose === 'code' ? projectIdFromSemanticNamespace(state.namespace) : null;
      if (!namespace && codeProjectId !== null && this.deps.semanticStore.getProjectTargets?.(codeProjectId)) continue;
      const route = this.deps.router.resolve(state.namespace, state.building_generation_id);
      const key = `${route.dbPath.toLowerCase()}\0${route.tableName}`;
      const group = groups.get(key) ?? {
        namespace: state.namespace,
        generationId: state.building_generation_id,
        dbPath: route.dbPath,
        tableName: route.tableName,
        namespaces: [],
      };
      group.namespaces.push(state.namespace);
      groups.set(key, group);
    }

    for (const group of groups.values()) {
      const hasActiveReference = states.some((state) => {
        if (state.active_generation_id !== group.generationId) return false;
        try {
          const route = this.deps.router.resolve(state.namespace, group.generationId);
          return route.dbPath.toLowerCase() === group.dbPath.toLowerCase()
            && route.tableName === group.tableName;
        } catch {
          return true;
        }
      });
      if (hasActiveReference) {
        throw new Error(`${purpose} generation rollout is incomplete for ${group.dbPath}`);
      }
      const job = this.deps.semanticStore.createJob({
        generation_id: group.generationId,
        namespace: group.namespace,
        kind: 'cleanup',
        priority: 100,
        cursor: { reason: 'abandoned-building', namespaces: group.namespaces },
      });
      await this.performCleanupJob(job);
    }
  },

async performCleanupJob(this: SemanticCoordinatorContext, job: SemanticJobRow): Promise<number> {
    if (!job.generation_id) {
      this.deps.semanticStore.updateJob(job.id, {
        status: 'failed', failed_items: 1, error: 'cleanup job has no generation',
      });
      throw new Error('semantic cleanup job has no generation');
    }
    this.deps.semanticStore.updateJob(job.id, { status: 'running', error: null });
    try {
      await this.workerDropGeneration(job.namespace, job.generation_id);
      const abandoned = Array.isArray(job.cursor?.namespaces)
        ? job.cursor.namespaces.filter((value): value is string => typeof value === 'string')
        : [];
      const cleanupNamespaces = Array.isArray(job.cursor?.cleanup_namespaces)
        ? job.cursor.cleanup_namespaces.filter((value): value is string => typeof value === 'string')
        : [];
      let removedItems = 0;
      for (const namespace of abandoned) {
        this.deps.semanticStore.clearBuildingGeneration(namespace, job.generation_id);
      }
      for (const namespace of new Set([...abandoned, ...cleanupNamespaces])) {
        removedItems += this.deps.semanticStore.deleteItemsForNamespaceGeneration(job.generation_id, namespace);
      }
      if (abandoned.length > 0) {
        const stillReferenced = this.deps.semanticStore.listNamespaceGenerations().some((state) =>
          state.active_generation_id === job.generation_id
          || state.building_generation_id === job.generation_id);
        if (!stillReferenced) {
          this.deps.semanticStore.updateGeneration(job.generation_id, {
            status: 'failed', error: 'abandoned construction generation was replaced',
          });
        }
      }
      this.deps.semanticStore.retireUnreferencedGenerations(
        this.deps.semanticStore.getGeneration(job.generation_id)?.purpose,
      );
      this.deps.semanticStore.updateJob(job.id, {
        status: 'completed', processed_items: 1, failed_items: 0, error: null,
      });
      return removedItems;
    } catch (error) {
      const message = errorMessage(error);
      this.deps.semanticStore.updateJob(job.id, {
        status: 'paused', failed_items: 1, error: message,
      });
      throw error;
    }
  },

assertNamespaceProjectActive(this: SemanticCoordinatorContext, namespace: string): void {
    const projectId = projectIdFromSemanticNamespace(namespace);
    if (projectId === null) return;
    if (this.projectTombstones.has(projectId)) {
      throw new Error(`Project ${projectId} semantic index is being removed`);
    }
    if (!this.deps.db.getProject(projectId)) {
      throw new Error(`Project ${projectId} not found`);
    }
  },

prepareNamespaceGeneration(this: SemanticCoordinatorContext,
    namespace: string,
    purpose: SemanticPurpose,
    generationId: number,
    expectedItems: number,
  ): void {
    this.assertNamespaceProjectActive(namespace);
    const current = this.deps.semanticStore.listNamespaceGenerations({ namespace })[0];
    if (current?.building_generation_id && current.building_generation_id !== generationId) {
      throw new Error(`abandoned generation ${current.building_generation_id} still blocks ${namespace}`);
    }
    if (current?.building_generation_id === generationId) {
      this.deps.semanticStore.updateNamespaceProgress(namespace, {
        expected_items: expectedItems,
        failed_items: 0,
        last_error: null,
      });
      return;
    }
    if (this.deps.semanticStore.getGeneration(generationId)?.status === 'ready') {
      this.deps.semanticStore.updateGeneration(generationId, {
        status: 'building',
        error: null,
      });
    }
    this.deps.semanticStore.beginNamespaceGeneration({
      namespace,
      purpose,
      generation_id: generationId,
      expected_items: expectedItems,
    });
  }
};
