import type { CodeIndexDB } from '@mcp/store/db.js';
import type { DocStore } from '@mcp/store/doc-store.js';
import {
  embeddingTargetsEqual,
  PROJECT_REMOVAL_NAMESPACE_PREFIX,
  projectIdFromRemovalNamespace,
  projectRemovalNamespace,
  type LocalVectorRouter,
  type SemanticGenerationRow,
  type SemanticJobRow,
  type SemanticPurpose,
  type SemanticStore,
} from '@mcp/store';
import type { EmbeddingService } from '@mcp/indexer/search/embeddings.js';
import { NullEmbeddingService } from '@mcp/indexer/search/embeddings.js';
import {
  EmbeddingPauseRequestedError,
  retryEmbeddings,
} from '@mcp/indexer/indexer/indexer/embed-retry.js';
import {
  buildEmbeddingCandidates,
  semanticItemKeysForCandidateFiles,
  semanticItemKeysForIndexedPaths,
  type CandidateFile,
} from '@mcp/indexer/indexer/indexer/embedding-candidates.js';
import type { LshIndexingSink } from '@mcp/indexer/indexer/lsh-indexing-sink.js';
import type { CostTracker } from '@mcp/services/services/costs.js';
import {
  embeddingFingerprintForGeneration,
  generationMatchesEmbeddingFingerprint,
  type VectorStore,
} from '@mcp/store/vectors.js';
import {
  snapshotEmbeddingTextHash,
  snapshotEmbeddingTexts,
  type SnapshotService,
} from '@mcp/services/services/snapshots.js';
import {
  agentMemoryEmbeddingTextHash,
  agentMemoryEmbeddingTexts,
  type AgentMemoryService,
} from '@mcp/services/memory/agent-memory-service.js';
import {
  investigationEmbeddingTextHash,
  type InvestigationSemanticIndex,
} from '@mcp/services/memory/investigation-semantic-index.js';
import {
  buildEmbeddingText,
  hashEmbeddingInput,
  type IndexDocumentationUseCase,
} from '@mcp/services/services/docs/index.js';
import type { DirtyEvent } from '@mcp/services/services/project-index/index.js';
import {
  codeNamespace,
  docNamespace,
  projectMemoryNamespace,
  snapshotNamespace,
  userMemoryNamespace,
} from '@mcp/shared/vector-namespace.js';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

interface CoordinatorDeps {
  db: CodeIndexDB;
  semanticStore: SemanticStore;
  router: LocalVectorRouter;
  vectorStore: VectorStore & {
    removeProject?(projectId: number): Promise<void>;
    dropGeneration?(namespace: string, generationId: number): Promise<void>;
    hasGeneration?(namespace: string, generationId: number): Promise<boolean>;
    compactGenerationDatabase?(
      namespace: string,
      generationId: number,
    ): Promise<{ before_bytes: number; after_bytes: number }>;
    listIds?(namespace: string, generationId: number): Promise<string[]>;
    deleteByIdsForGeneration?(namespace: string, generationId: number, ids: string[]): Promise<number>;
    deleteByItemKeysForGeneration?(
      namespace: string,
      generationId: number,
      itemKeys: string[],
    ): Promise<number>;
  };
  codeEmbedding: EmbeddingService;
  knowledgeEmbedding: EmbeddingService;
  costTracker: CostTracker;
  lshSink: LshIndexingSink;
  snapshotService: SnapshotService;
  agentMemoryService: AgentMemoryService;
  investigationSemanticIndex: InvestigationSemanticIndex;
  docStore: DocStore;
  docsIndexer: IndexDocumentationUseCase;
  indexProfile?: 'aggressive' | 'balanced' | 'conservative';
  withProjectLock?<T>(projectId: number, operation: () => Promise<T>): Promise<T>;
  /** Owner id used by Snapshot/AgentMemory durable fences in this process. */
  mutationFenceOwner?: string;
}

type ReindexResult = {
  purpose: SemanticPurpose;
  generation_id: number | null;
  completed_namespaces: string[];
  failed_namespaces: Array<{ namespace: string; error: string }>;
  skipped?: 'disabled';
};

export interface SemanticUnusedVectorCleanupResult {
  tables_removed: number;
  items_removed: number;
  databases_compacted: number;
  bytes_reclaimed: number;
  skipped_referenced: number;
  failures: Array<{ namespace: string; generation_id: number; error: string }>;
}

type ProjectRemovalOptions = {
  /** Runs under both the structural mutex and semantic namespace barriers. */
  finalize?: () => void | Promise<void>;
  /** Clear the durable tombstone after finalize when the project row remains. */
  retainProject?: boolean;
};

type ProjectRemovalKind = 'cleanup' | 'delete' | 'clear';

function projectRemovalKind(options: ProjectRemovalOptions): ProjectRemovalKind {
  if (options.retainProject) return 'clear';
  return options.finalize ? 'delete' : 'cleanup';
}

class DeltaBuildPendingError extends Error {
  constructor(namespace: string) {
    super(`delta queue pending for ${namespace}`);
    this.name = 'DeltaBuildPendingError';
  }
}

export class SemanticVectorWorkerUnavailableError extends Error {
  readonly code = 'SEMANTIC_VECTOR_WORKER_UNAVAILABLE';

  constructor(operation: string) {
    super(`semantic vector worker unavailable: ${operation}; semantic indexing is paused and FTS remains active`);
    this.name = 'SemanticVectorWorkerUnavailableError';
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const DOCS_BACKFILL_RETRY_MS = 30_000;
const PROJECT_REMOVAL_RETRY_MS = 30_000;
const CODE_DELTA_PATH_LIMIT = 512;
const CODE_VERIFY_WAVE_FILES = 25;

type CodeDeltaCursor = {
  events: DirtyEvent[];
  previous_item_keys: string[];
};

function readCodeDeltaCursor(cursor: Record<string, unknown> | null): CodeDeltaCursor {
  const events = Array.isArray(cursor?.events)
    ? cursor.events.flatMap((value): DirtyEvent[] => {
        if (!value || typeof value !== 'object') return [];
        const row = value as { path?: unknown; kind?: unknown };
        if (typeof row.path !== 'string' || (row.kind !== 'upsert' && row.kind !== 'delete')) return [];
        return [{ path: row.path.replace(/\\/g, '/'), kind: row.kind }];
      })
    : [];
  const previousItemKeys = Array.isArray(cursor?.previous_item_keys)
    ? cursor.previous_item_keys.filter((value): value is string => typeof value === 'string')
    : [];
  return { events, previous_item_keys: previousItemKeys };
}

function mergeCodeDeltaCursor(
  current: Record<string, unknown> | null,
  events: readonly DirtyEvent[],
  previousItemKeys: readonly string[],
): CodeDeltaCursor {
  const before = readCodeDeltaCursor(current);
  const byPath = new Map<string, DirtyEvent>();
  for (const event of [...before.events, ...events]) {
    const path = event.path.replace(/\\/g, '/');
    byPath.set(path, { path, kind: event.kind });
  }
  const mergedEvents = byPath.size > CODE_DELTA_PATH_LIMIT
    ? [{ path: '*', kind: 'upsert' as const }]
    : [...byPath.values()];
  const mergedKeys = mergedEvents[0]?.path === '*'
    ? []
    : [...new Set([...before.previous_item_keys, ...previousItemKeys])];
  return { events: mergedEvents, previous_item_keys: mergedKeys };
}

function projectIdFromSemanticNamespace(namespace: string): number | null {
  const match = /^(?:code|snapshot|memory:project):p(\d+)$/.exec(namespace);
  return match ? Number(match[1]) : null;
}

/** Persistent generation/job coordinator. Relational FTS remains searchable
 * throughout a build; only complete, delta-free namespaces are activated. */
export class SemanticIndexCoordinator {
  private readonly locks = new Map<string, Promise<void>>();
  /** Public catch-up requests are idempotent per namespace. `serial` remains a
   * queue for mutation/removal barriers, while this map makes duplicate UI,
   * watcher and agent wake-ups share one semantic pass. */
  private readonly codeCatchupRuns = new Map<string, Promise<void>>();
  private readonly projectReindexRuns = new Map<number, Promise<ReindexResult>>();
  private readonly projectReindexDispatches = new Map<number, Promise<void>>();
  private readonly codeProjectLeases = new Map<number, Set<string>>();
  private readonly codePauseRequested = new Set<number>();
  private codeBuildTail: Promise<void> = Promise.resolve();
  private readonly purposeRuns = new Map<SemanticPurpose, Promise<ReindexResult>>();
  /** Generation creation is purpose-scoped so explicit project requests share
   * a compatible vector space instead of probing/creating duplicates. */
  private readonly generationRuns = new Map<SemanticPurpose, Promise<SemanticGenerationRow>>();
  private readonly cleanupRuns = new Map<string, Promise<void>>();
  private readonly unusedVectorCleanupRuns = new Map<string, Promise<SemanticUnusedVectorCleanupResult>>();
  private readonly projectRemovalRuns = new Map<number, {
    kind: ProjectRemovalKind;
    promise: Promise<void>;
  }>();
  private readonly projectTombstones = new Set<number>();
  private readonly docsMutationOwner = randomUUID();
  private readonly knowledgeMutationOwner: string;
  private docsBackfillTimer: ReturnType<typeof setTimeout> | null = null;
  private docsBackfillRun: Promise<number> | null = null;
  private projectRemovalRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private projectRemovalRecoveryRun: Promise<number> | null = null;
  private disposed = false;

  constructor(private readonly deps: CoordinatorDeps) {
    this.knowledgeMutationOwner = deps.mutationFenceOwner ?? randomUUID();
    // No request can own this fresh process id yet, so every differently-owned
    // fence is crash residue. Server boot synchronously recovers stale source
    // rows before timers or routes can drive the pending catch-up.
    this.deps.semanticStore.recoverNamespaceMutationFences?.(
      'docs:c',
      this.docsMutationOwner,
    );
    this.recoverExpiredKnowledgeMutationFences();
    // Keep completed removal markers fenced until the caller deletes the
    // project row. This survives a crash in the gap after vectors.db is gone.
    for (const job of deps.semanticStore.listJobs()) {
      if (job.kind !== 'cleanup' || job.cursor?.reason !== 'project-removal') continue;
      const projectId = projectIdFromRemovalNamespace(job.namespace);
      if (projectId !== null && job.status !== 'failed' && job.status !== 'cancelled') {
        this.projectTombstones.add(projectId);
      }
    }
    // External clients can publish a marker without sharing this process's
    // in-memory Set. Polling is a recovery path for a failed/missed localhost
    // wake-up and also closes the crash gap after physical cleanup.
    this.scheduleProjectRemovalRetry(1_000);
  }

  /** Global documentation and user memory do not resolve to a project id, so
   * they remain writable while a project-local vector database is removed. */
  allowsNamespaceMutation(namespace: string): boolean {
    const projectId = projectIdFromSemanticNamespace(namespace);
    return projectId === null
      || (!this.projectTombstones.has(projectId)
        && !(this.deps.semanticStore as SemanticStore & {
          hasProjectRemovalRequest?: SemanticStore['hasProjectRemovalRequest'];
        }).hasProjectRemovalRequest?.(projectId)
        && !!this.deps.db.getProject(projectId));
  }

  reindex(purpose: SemanticPurpose, force = true): Promise<ReindexResult> {
    if (this.embeddingDisabled(purpose)) return Promise.resolve(this.disabledResult(purpose));
    const running = this.purposeRuns.get(purpose);
    if (running) return running;
    const run = this.runPurpose(purpose, force).finally(() => this.purposeRuns.delete(purpose));
    this.purposeRuns.set(purpose, run);
    return run;
  }

  /** Project-open lifecycle hook. Automatic semantic work is strictly local
   * and project-scoped: provider targets never receive a surprise request and
   * no registered-but-closed project is fanned out. */
  activateCodeProject(projectId: number, leaseId = 'editor'): SemanticJobRow | null {
    const project = this.deps.db.getProject(projectId);
    if (!project || project.is_synthetic) return null;
    const leases = this.codeProjectLeases.get(projectId) ?? new Set<string>();
    leases.add(leaseId);
    this.codeProjectLeases.set(projectId, leases);
    this.codePauseRequested.delete(projectId);
    const target = this.deps.semanticStore.getProfile('code')?.embedding_target;
    if (target?.kind !== 'onnx' && target?.kind !== 'local_http') return null;
    const namespace = codeNamespace(projectId);
    const state = this.deps.semanticStore.listNamespaceGenerations({ namespace })[0];
    if (state?.active_generation_id && !state.building_generation_id) {
      const pendingDelta = this.deps.semanticStore.listJobs({ namespace }).find((job) =>
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
  }

  /** Last editor/agent lease left. The current ONNX batch is allowed to
   * finish; retryEmbeddings observes this fence before reading the next wave. */
  deactivateCodeProject(projectId: number, leaseId = 'editor'): boolean {
    const leases = this.codeProjectLeases.get(projectId);
    if (leases) {
      leases.delete(leaseId);
      if (leases.size > 0) return false;
      this.codeProjectLeases.delete(projectId);
    }
    this.codePauseRequested.add(projectId);
    return true;
  }

  /** Agent sessions can keep a project build alive after its visible editor
   * tab closes. Releasing the returned lease is idempotent. */
  acquireCodeProjectLease(projectId: number, leaseId: string): () => void {
    this.activateCodeProject(projectId, `agent:${leaseId}`);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.deactivateCodeProject(projectId, `agent:${leaseId}`);
    };
  }

  pauseJob(jobId: number): SemanticJobRow {
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
  }

  resumeJob(jobId: number): SemanticJobRow {
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

  /** Explicit administrative sweep for obsolete physical generation tables.
   * Routing is proven per SQLite/table, so a generation still serving another
   * project or collection cannot be removed accidentally. */
  cleanupUnusedVectors(projectId?: number): Promise<SemanticUnusedVectorCleanupResult> {
    const key = projectId === undefined ? 'global' : `project:${projectId}`;
    const existing = this.unusedVectorCleanupRuns.get(key);
    if (existing) return existing;
    if (this.unusedVectorCleanupRuns.size > 0) {
      return Promise.reject(new Error('another unused vector cleanup is already running'));
    }
    const running = this.performUnusedVectorCleanup(projectId).finally(() => {
      if (this.unusedVectorCleanupRuns.get(key) === running) this.unusedVectorCleanupRuns.delete(key);
    });
    this.unusedVectorCleanupRuns.set(key, running);
    return running;
  }

  private async performUnusedVectorCleanup(projectId?: number): Promise<SemanticUnusedVectorCleanupResult> {
    const hasGeneration = this.deps.vectorStore.hasGeneration;
    const compact = this.deps.vectorStore.compactGenerationDatabase;
    if (!hasGeneration || !compact || !this.deps.vectorStore.dropGeneration) {
      throw new SemanticVectorWorkerUnavailableError('unused vector cleanup');
    }
    const executing = this.deps.semanticStore.listJobs().some((job) =>
      // Pending rows are durable requests waiting for an explicit wake-up;
      // only running means a worker currently owns the physical database.
      job.status === 'running'
      && (job.kind === 'build' || job.kind === 'backfill')
      // Superseded jobs are historical control-plane residue, not live work.
      && this.jobGenerationIsReferenced(job)
      // A project-scoped cleanup owns only that project's vectors.db. Work in
      // another project or in a global docs/memory database must not block it.
      && (projectId === undefined || this.semanticProjectIdForJob(job) === projectId));
    if (executing) throw new Error('wait for semantic builds to finish before cleaning unused vectors');

    this.deps.semanticStore.retireUnreferencedGenerations();
    const states = this.deps.semanticStore.listNamespaceGenerations();
    const groups = new Map<string, {
      namespace: string;
      generationId: number;
      dbPath: string;
      tableName: string;
      namespaces: Set<string>;
    }>();
    for (const generation of this.deps.semanticStore.listGenerations()) {
      for (const namespace of this.deps.semanticStore.listGenerationNamespaces(generation.id)) {
        let route: ReturnType<LocalVectorRouter['resolve']>;
        try { route = this.deps.router.resolve(namespace, generation.id); }
        catch { continue; }
        if (projectId !== undefined && route.projectId !== projectId) continue;
        const key = `${route.dbPath.toLowerCase()}\0${route.tableName}`;
        const group = groups.get(key) ?? {
          namespace,
          generationId: generation.id,
          dbPath: route.dbPath,
          tableName: route.tableName,
          namespaces: new Set<string>(),
        };
        group.namespaces.add(namespace);
        groups.set(key, group);
      }
    }

    const result: SemanticUnusedVectorCleanupResult = {
      tables_removed: 0,
      items_removed: 0,
      databases_compacted: 0,
      bytes_reclaimed: 0,
      skipped_referenced: 0,
      failures: [],
    };
    const compactTargets = new Map<string, { namespace: string; generationId: number }>();

    for (const group of groups.values()) {
      const referenced = states.some((state) => [
        state.active_generation_id,
        state.building_generation_id,
      ].filter((id): id is number => id !== null).some((generationId) => {
        try {
          const route = this.deps.router.resolve(state.namespace, generationId);
          return route.dbPath.toLowerCase() === group.dbPath.toLowerCase()
            && route.tableName === group.tableName;
        } catch {
          return true;
        }
      }));
      if (referenced) {
        result.skipped_referenced += 1;
        continue;
      }

      try {
        const exists = await hasGeneration.call(
          this.deps.vectorStore,
          group.namespace,
          group.generationId,
        );
        if (!exists) {
          for (const namespace of group.namespaces) {
            result.items_removed += this.deps.semanticStore.deleteItemsForNamespaceGeneration(
              group.generationId,
              namespace,
            );
          }
          continue;
        }
        const job = this.deps.semanticStore.createJob({
          generation_id: group.generationId,
          namespace: group.namespace,
          kind: 'cleanup',
          priority: 100,
          cursor: {
            reason: 'manual-unused-vectors',
            cleanup_namespaces: [...group.namespaces],
            db_path: group.dbPath,
            table_name: group.tableName,
          },
        });
        result.items_removed += await this.performCleanupJob(job);
        result.tables_removed += 1;
        compactTargets.set(group.dbPath.toLowerCase(), {
          namespace: group.namespace,
          generationId: group.generationId,
        });
      } catch (error) {
        result.failures.push({
          namespace: group.namespace,
          generation_id: group.generationId,
          error: errorMessage(error),
        });
      }
    }

    for (const target of compactTargets.values()) {
      try {
        const sizes = await compact.call(
          this.deps.vectorStore,
          target.namespace,
          target.generationId,
        );
        result.databases_compacted += 1;
        result.bytes_reclaimed += Math.max(0, sizes.before_bytes - sizes.after_bytes);
      } catch (error) {
        result.failures.push({
          namespace: target.namespace,
          generation_id: target.generationId,
          error: `vectors removed but database compaction failed: ${errorMessage(error)}`,
        });
      }
    }

    const referencedGenerationIds = new Set(states.flatMap((state) => [
      state.active_generation_id,
      state.building_generation_id,
    ].filter((id): id is number => id !== null)));
    for (const generation of this.deps.semanticStore.listGenerations()) {
      if (generation.status === 'building' && !referencedGenerationIds.has(generation.id)) {
        this.deps.semanticStore.updateGeneration(generation.id, {
          status: 'failed',
          error: 'unused construction generation was cleaned',
        });
      }
    }
    this.deps.semanticStore.retireUnreferencedGenerations();
    return result;
  }

  /** Explicitly ensure the project's first generation, or drain its persisted
   * delta queue when a generation already exists. This method never fans out
   * to another project. */
  ensureCodeProject(projectId: number): Promise<void> {
    return this.coalesceCodeCatchup(projectId, async () => {
      const generation = await this.ensureGeneration('code', false);
      await this.runCodeProjectBuild(projectId, generation, false);
    });
  }

  /** Watcher/editor hook. A change never creates the first generation by
   * itself: without an active/explicitly-building namespace the durable delta
   * stays pending until the user requests this project. */
  catchUpCodeProject(projectId: number): Promise<void> {
    if (this.embeddingDisabled('code')) return Promise.resolve();
    const namespace = codeNamespace(projectId);
    const state = this.deps.semanticStore.listNamespaceGenerations({ namespace })[0];
    const generationId = state?.building_generation_id ?? state?.active_generation_id;
    if (!generationId) return Promise.resolve();
    const requiresExplicitSweep = this.deps.semanticStore.listJobs({ namespace }).some((job) => {
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
  }

  /** Explicit project-scoped rebuild used by the per-project API. A forced
   * request creates a replacement vector space, but only code:p<ID> is built. */
  reindexCodeProject(projectId: number, force = true): Promise<ReindexResult> {
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
  }

  /** Persist and asynchronously dispatch an explicit project request. The
   * marker is intentionally never consumed by startup; a paused restart job
   * resumes only when this method is called again. */
  enqueueCodeProjectReindex(
    projectId: number,
    force = true,
    reason = 'explicit-project-reindex',
  ): SemanticJobRow {
    const project = this.deps.db.getProject(projectId);
    if (!project || project.is_synthetic) throw new Error(`Project ${projectId} not found`);
    const markerNamespace = `semantic:reindex:code:p${projectId}`;
    const existing = this.deps.semanticStore.listJobs({ namespace: markerNamespace }).find((job) =>
      job.kind === 'build'
      && (job.status === 'pending' || job.status === 'running' || job.status === 'paused'));
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
        expected_items: this.deps.db.listFiles(projectId).length,
        ...(existing.status === 'running' ? {} : { processed_items: 0, failed_items: 0, error: null }),
      }) ?? existing;
    } else {
      job = this.deps.semanticStore.createJob({
        generation_id: null,
        namespace: markerNamespace,
        kind: 'build',
        priority: reason.startsWith('automatic-') ? 20 : 100,
        cursor: { reason, project_id: projectId, force, pause_requested: false },
        expected_items: this.deps.db.listFiles(projectId).length,
      });
    }
    if (job.status !== 'running') queueMicrotask(() => this.dispatchCodeProjectReindex(projectId, job.id));
    return job;
  }

  private dispatchCodeProjectReindex(projectId: number, jobId: number): void {
    if (this.projectReindexDispatches.has(projectId)) return;
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
  }

  private coalesceCodeCatchup(projectId: number, operation: () => Promise<void>): Promise<void> {
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
  }

  private async runCodeProjectBuild(
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
  }

  private shouldPauseCodeProject(projectId: number): boolean {
    return this.codePauseRequested.has(projectId)
      && (this.codeProjectLeases.get(projectId)?.size ?? 0) === 0;
  }

  private codeProjectIdForJob(job: SemanticJobRow): number | null {
    const cursorProjectId = Number(job.cursor?.project_id);
    if (Number.isSafeInteger(cursorProjectId) && cursorProjectId > 0) return cursorProjectId;
    const match = /^(?:code:p|semantic:reindex:code:p)(\d+)$/.exec(job.namespace);
    return match ? Number(match[1]) : null;
  }

  private semanticProjectIdForJob(job: SemanticJobRow): number | null {
    const codeProjectId = this.codeProjectIdForJob(job);
    if (codeProjectId !== null) return codeProjectId;
    const match = /^(?:snapshot:p|memory:project:p)(\d+)$/.exec(job.namespace);
    return match ? Number(match[1]) : null;
  }

  /** Targeted catch-up used by synchronous snapshot/memory mutation sinks.
   * Namespace locking keeps it compatible with a concurrent full Knowledge
   * rollout, while the durable job remains the crash/restart source of truth. */
  ensureKnowledgeNamespace(namespace: string): Promise<void> {
    if (this.embeddingDisabled('knowledge')) return Promise.resolve();
    if (!this.allowsNamespaceMutation(namespace)) return Promise.resolve();
    return this.serial(namespace, async () => {
      if (this.embeddingDisabled('knowledge') || !this.allowsNamespaceMutation(namespace)) return;
      const generation = await this.ensureGeneration('knowledge', false);
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
          throw new Error(`Unsupported Knowledge mutation namespace: ${namespace}`);
        }
      } finally {
        this.refreshGenerationProgress(generation.id);
      }
    });
  }

  /** Mutation wake-up that preserves the on-demand invariant. Generation-less
   * deltas remain durable but do not load an embedding model on project open. */
  catchUpKnowledgeNamespace(namespace: string): Promise<void> {
    if (this.embeddingDisabled('knowledge') || !this.allowsNamespaceMutation(namespace)) {
      return Promise.resolve();
    }
    const state = this.deps.semanticStore.listNamespaceGenerations({ namespace })[0];
    if (!state?.active_generation_id && !state?.building_generation_id) return Promise.resolve();
    return this.ensureKnowledgeNamespace(namespace);
  }

  /** Create the durable pre-mutation fence used by documentation ingestion
   * and source deletion. Acquiring the same short namespace lock as builds
   * means a new relational mutation cannot begin inside an activation proof;
   * the committed job still exists before the caller's first corpus write. */
  async beginDocsCollectionMutation(
    collectionId: number,
    operation: 'upsert' | 'delete',
  ): Promise<{ job_id: number; token: string } | null> {
    let fence: { job_id: number; token: string } | null = null;
    await this.serial(docNamespace(collectionId), async () => {
      // Recheck inside the lock: collection deletion may have been ahead of
      // this request while waiting on a vector checkpoint.
      if (!this.docsCollectionExists(collectionId)) {
        throw new Error(`Documentation collection ${collectionId} not found`);
      }
      if (this.embeddingDisabled('knowledge')) return;
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
  }

  /** A settled fence remains pending until a complete pass acknowledges its
   * exact watermark. A failed ingestion may already have changed chunks, so
   * its fence is deliberately reconciled rather than discarded. */
  endDocsCollectionMutation(
    fence: { job_id: number; token: string } | null,
    mutationError: unknown = null,
  ): void {
    if (!fence) return;
    this.deps.semanticStore.settleNamespaceMutationFence({
      ...fence,
      mutation_error: mutationError == null ? null : errorMessage(mutationError),
    });
  }

  /** Collection deletion owns the whole docs namespace and must queue behind
   * any generation build. Refuse to race a still-live corpus mutation; its
   * caller will settle the durable fence in `finally` and deletion is then
   * safely retryable. */
  async runDocsCollectionExclusive<T>(
    collectionId: number,
    operation: () => Promise<T>,
  ): Promise<T> {
    let result!: T;
    await this.serial(docNamespace(collectionId), async () => {
      const inFlight = this.deps.semanticStore.listJobs({ namespace: docNamespace(collectionId) })
        .some((job) => job.kind === 'delta'
          && job.status === 'running'
          && job.cursor?.reason === 'mutation-fence'
          && job.cursor?.fence_phase === 'in-flight');
      if (inFlight) {
        throw new Error(`Documentation collection ${collectionId} is currently being mutated`);
      }
      result = await operation();
    });
    return result;
  }

  /** Establish the construction namespace before an ingestion pipeline starts
   * embedding a newly-created collection. Relational ingestion can still
   * proceed when this throws; callers surface the classified semantic error
   * while FTS remains available. */
  async prepareDocsCollection(collectionId: number): Promise<void> {
    const namespace = docNamespace(collectionId);
    if (!this.docsCollectionExists(collectionId)) {
      throw new Error(`Documentation collection ${collectionId} not found`);
    }
    if (this.embeddingDisabled('knowledge')) return;
    try {
      await this.serial(namespace, async () => {
        if (this.embeddingDisabled('knowledge')) return;
        const generation = await this.ensureGeneration('knowledge', false);
        const state = this.deps.semanticStore.listNamespaceGenerations({ namespace })[0];
        // An incremental ingest writes into the already-serving generation.
        // Pointing `building` at that same id violates migration 227's CHECK
        // and is unnecessary because the pre-mutation fence blocks races.
        if (state?.active_generation_id !== generation.id) {
          this.prepareNamespaceGeneration(
            namespace,
            'knowledge',
            generation.id,
            this.deps.docStore.countChunksByCollection(collectionId),
          );
        }
        this.refreshGenerationProgress(generation.id);
      });
    } catch (error) {
      if (this.embeddingDisabled('knowledge')) return;
      this.queueDocsBackfill(collectionId, error);
      throw error;
    }
  }

  /** Finalize an ingestion against current chunks. Accepted semantic_items are
   * reused; only missing/stale chunks are embedded before the physical gate. */
  async ensureDocsCollection(collectionId: number): Promise<void> {
    const namespace = docNamespace(collectionId);
    if (!this.docsCollectionExists(collectionId)) {
      throw new Error(`Documentation collection ${collectionId} not found`);
    }
    if (this.embeddingDisabled('knowledge')) return;
    try {
      await this.serial(namespace, async () => {
        if (this.embeddingDisabled('knowledge')) return;
        const generation = await this.ensureGeneration('knowledge', false);
        try {
          await this.buildDocsNamespace(collectionId, generation, false);
        } finally {
          this.refreshGenerationProgress(generation.id);
        }
      });
    } catch (error) {
      if (this.embeddingDisabled('knowledge')) return;
      this.queueDocsBackfill(collectionId, error);
      throw error;
    }
  }

  /** Drain generation-less documentation jobs left by corpus-first ingestion.
   * The job survives app restarts and is safe to retry because both namespace
   * preparation and embedding upserts are idempotent. */
  retryPendingDocsBackfills(): Promise<number> {
    if (this.embeddingDisabled('knowledge')) {
      this.pauseDocsBackfillsForDisabled();
      return Promise.resolve(0);
    }
    if (this.docsBackfillRun) return this.docsBackfillRun;
    const run = this.drainPendingDocsBackfills().finally(() => {
      if (this.docsBackfillRun === run) this.docsBackfillRun = null;
      if (!this.embeddingDisabled('knowledge') && this.hasPendingDocsBackfills()) {
        this.scheduleDocsBackfillRetry();
      }
    });
    this.docsBackfillRun = run;
    return run;
  }

  /** File changes arriving during a build become a persistent delta count.
   * The builder drains it before activation; changes after activation are
   * handled by the ordinary incremental embedding path. */
  noteCodeDelta(projectId: number, events: readonly DirtyEvent[] = []): void {
    if (this.embeddingDisabled('code')) return;
    const namespace = codeNamespace(projectId);
    if (!this.allowsNamespaceMutation(namespace)) return;
    const state = this.deps.semanticStore.listNamespaceGenerations({ namespace })[0];
    const normalized = events.length > 0
      ? Array.from(new Map(events.map((event) => [
          `${event.kind}\0${event.path}`,
          { kind: event.kind, path: event.path.replace(/\\/g, '/') },
        ])).values())
      : [{ kind: 'upsert' as const, path: '*' }];
    const concretePaths = normalized
      .filter((event) => event.path !== '*')
      .map((event) => event.path);
    const previousItemKeys = concretePaths.length > 0
      ? semanticItemKeysForIndexedPaths(this.deps.db, projectId, concretePaths)
      : [];
    const generationId = state?.building_generation_id ?? state?.active_generation_id ?? null;
    const kind = generationId === null ? 'backfill' as const : 'delta' as const;
    const existing = this.deps.semanticStore.listJobs({ namespace }).find((job) =>
      job.generation_id === generationId
      && job.kind === kind
      && (job.status === 'pending' || job.status === 'paused')
      && job.cursor?.reason === 'code-delta');
    const cursor = mergeCodeDeltaCursor(existing?.cursor ?? null, normalized, previousItemKeys);
    const nextExpected = cursor.events.length;
    const previousExpected = existing?.expected_items ?? 0;
    if (existing) {
      this.deps.semanticStore.updateJob(existing.id, {
        status: 'pending',
        cursor: {
          reason: 'code-delta',
          requires_explicit_reindex: cursor.events.some((event) => event.path === '*'),
          ...cursor,
        },
        expected_items: nextExpected,
        processed_items: 0,
        failed_items: 0,
        error: null,
      });
    } else {
      this.deps.semanticStore.createJob({
        generation_id: generationId,
        namespace,
        kind,
        priority: 40,
        cursor: {
          reason: 'code-delta',
          requires_explicit_reindex: cursor.events.some((event) => event.path === '*'),
          ...cursor,
        },
        expected_items: nextExpected,
      });
    }
    if (state && generationId !== null) {
      this.deps.semanticStore.updateNamespaceProgress(namespace, {
        delta_items: Math.max(0, state.delta_items + nextExpected - previousExpected),
      });
    }
  }

  removeProject(projectId: number, options: ProjectRemovalOptions = {}): Promise<void> {
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
  }

  private async performProjectRemoval(
    projectId: number,
    options: ProjectRemovalOptions,
  ): Promise<void> {
    const namespaces = [
      codeNamespace(projectId),
      snapshotNamespace(projectId),
      projectMemoryNamespace(projectId),
    ];
    const markerNamespace = projectRemovalNamespace(projectId);
    const existingMarker = this.deps.semanticStore.listJobs({ namespace: markerNamespace })
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
  }

  /** Compatibility entrypoint called by bootstrap. Startup is deliberately
   * passive: interrupted embedding jobs become visible/paused, but no project
   * enumeration, model probe or vector build starts until an explicit request
   * or a new targeted mutation arrives. */
  recoverInterruptedJobsPassively(): void {
    for (const job of this.deps.semanticStore.listJobs()) {
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
  }

  private jobGenerationIsReferenced(job: SemanticJobRow): boolean {
    if (job.generation_id === null) return true;
    const state = this.deps.semanticStore.listNamespaceGenerations({ namespace: job.namespace })[0];
    return state?.active_generation_id === job.generation_id
      || state?.building_generation_id === job.generation_id;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.docsBackfillTimer) clearTimeout(this.docsBackfillTimer);
    this.docsBackfillTimer = null;
    if (this.projectRemovalRetryTimer) clearTimeout(this.projectRemovalRetryTimer);
    this.projectRemovalRetryTimer = null;
    await this.docsBackfillRun?.catch(() => undefined);
    await this.projectRemovalRecoveryRun?.catch(() => undefined);
  }

  private recoverExpiredKnowledgeMutationFences(now = Date.now()): number {
    return [
      'snapshot:p',
      'memory:project:p',
      'memory:user',
    ].reduce((total, prefix) => total + this.deps.semanticStore.recoverNamespaceMutationFences(
      prefix,
      this.knowledgeMutationOwner,
      now,
    ), 0);
  }

  /**
   * Consume project-removal requests published by another process. Only jobs
   * explicitly marked `finalize_project` are eligible: ordinary server
   * cleanup markers retain their existing caller-owned lifecycle.
   */
  retryPendingProjectRemovals(): Promise<number> {
    if (this.projectRemovalRecoveryRun) return this.projectRemovalRecoveryRun;
    const run = this.drainPendingProjectRemovals().finally(() => {
      if (this.projectRemovalRecoveryRun === run) this.projectRemovalRecoveryRun = null;
    });
    this.projectRemovalRecoveryRun = run;
    return run;
  }

  private scheduleProjectRemovalRetry(delayMs = PROJECT_REMOVAL_RETRY_MS): void {
    if (this.disposed || this.projectRemovalRetryTimer) return;
    this.projectRemovalRetryTimer = setTimeout(() => {
      this.projectRemovalRetryTimer = null;
      void this.retryPendingProjectRemovals()
        .catch((error) => console.warn(`[semantic] project removal retry paused: ${errorMessage(error)}`))
        .finally(() => this.scheduleProjectRemovalRetry(PROJECT_REMOVAL_RETRY_MS));
    }, Math.max(1, delayMs));
    this.projectRemovalRetryTimer.unref?.();
  }

  private async drainPendingProjectRemovals(): Promise<number> {
    let completed = 0;
    const requests = this.deps.semanticStore.listJobs().filter((job) =>
      job.kind === 'cleanup'
      && job.cursor?.reason === 'project-removal'
      && job.cursor?.finalize_project === true
      && (job.status === 'pending' || job.status === 'paused' || job.status === 'running'));
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

  private docsCollectionExists(collectionId: number): boolean {
    return this.deps.docStore.listCollections().some((collection) => collection.id === collectionId);
  }

  /** The profile row is the authoritative operator intent. The Null service
   * check keeps legacy/manual coordinator wiring FTS-only as well. */
  private embeddingDisabled(purpose: SemanticPurpose): boolean {
    const profile = this.deps.semanticStore.getProfile(purpose);
    if (profile) return profile.embedding_target.kind === 'disabled';
    const embedding = purpose === 'code' ? this.deps.codeEmbedding : this.deps.knowledgeEmbedding;
    if (embedding instanceof NullEmbeddingService) return true;
    try {
      return embedding.fingerprint?.() === 'null';
    } catch {
      return false;
    }
  }

  private disabledResult(purpose: SemanticPurpose): ReindexResult {
    return {
      purpose,
      generation_id: null,
      completed_namespaces: [],
      failed_namespaces: [],
      skipped: 'disabled',
    };
  }

  private pauseDocsBackfillsForDisabled(): void {
    for (const job of this.pendingDocsBackfillJobs()) {
      if (job.status === 'paused' && job.error === 'knowledge semantic profile is disabled') continue;
      this.deps.semanticStore.updateJob(job.id, {
        status: 'paused',
        error: 'knowledge semantic profile is disabled',
      });
    }
  }

  private queueDocsBackfill(collectionId: number, error: unknown): void {
    if (this.embeddingDisabled('knowledge') || !this.docsCollectionExists(collectionId)) return;
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
  }

  private pendingDocsBackfillJobs(): SemanticJobRow[] {
    return this.deps.semanticStore.listJobs().filter((job) =>
      job.generation_id === null
      && job.kind === 'backfill'
      && /^docs:c\d+$/.test(job.namespace)
      && (job.status === 'pending' || job.status === 'paused' || job.status === 'running'));
  }

  private hasPendingDocsBackfills(): boolean {
    return this.pendingDocsBackfillJobs().length > 0;
  }

  private scheduleDocsBackfillRetry(delayMs = DOCS_BACKFILL_RETRY_MS): void {
    if (
      this.disposed
      || this.embeddingDisabled('knowledge')
      || this.docsBackfillTimer
      || this.docsBackfillRun
    ) return;
    this.docsBackfillTimer = setTimeout(() => {
      this.docsBackfillTimer = null;
      void this.retryPendingDocsBackfills().catch((error) =>
        console.warn(`[semantic] docs backfill retry paused: ${errorMessage(error)}`));
    }, Math.max(1, delayMs));
    this.docsBackfillTimer.unref?.();
  }

  private async drainPendingDocsBackfills(): Promise<number> {
    if (this.embeddingDisabled('knowledge')) {
      this.pauseDocsBackfillsForDisabled();
      return 0;
    }
    let completed = 0;
    for (const job of this.pendingDocsBackfillJobs()) {
      if (this.embeddingDisabled('knowledge')) {
        this.pauseDocsBackfillsForDisabled();
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
        if (this.embeddingDisabled('knowledge')) {
          this.deps.semanticStore.updateJob(job.id, {
            status: 'paused',
            cursor,
            error: 'knowledge semantic profile is disabled',
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

  private async runPurpose(purpose: SemanticPurpose, force: boolean): Promise<ReindexResult> {
    if (this.embeddingDisabled(purpose)) return this.disabledResult(purpose);
    const generation = await this.ensureGeneration(purpose, force);
    const completed: string[] = [];
    const failed: Array<{ namespace: string; error: string }> = [];
    const run = async (namespace: string, build: () => Promise<void>): Promise<void> => {
      if (!this.allowsNamespaceMutation(namespace)) return;
      try {
        await this.serial(namespace, build);
        if (this.allowsNamespaceMutation(namespace)) completed.push(namespace);
      } catch (error) {
        failed.push({ namespace, error: errorMessage(error) });
      }
    };

    if (purpose === 'code') {
      for (const project of this.deps.db.listProjects()) {
        if (project.is_synthetic) continue;
        const build = () => run(
          codeNamespace(project.id),
          () => this.runCodeProjectBuild(project.id, generation, force),
        );
        if (this.deps.withProjectLock) await this.deps.withProjectLock(project.id, build);
        else await build();
      }
    } else {
      for (const collection of this.deps.docStore.listCollections()) {
        await run(docNamespace(collection.id), () => this.buildDocsNamespace(collection.id, generation, force));
      }
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
  }

  private ensureGeneration(purpose: SemanticPurpose, force: boolean): Promise<SemanticGenerationRow> {
    const previous = this.generationRuns.get(purpose);
    const current = (previous ? previous.catch(() => undefined) : Promise.resolve())
      .then(() => this.resolveGeneration(purpose, force));
    const tracked = current.finally(() => {
      if (this.generationRuns.get(purpose) === tracked) this.generationRuns.delete(purpose);
    });
    this.generationRuns.set(purpose, tracked);
    return tracked;
  }

  private async resolveGeneration(purpose: SemanticPurpose, force: boolean): Promise<SemanticGenerationRow> {
    const embedding = purpose === 'code' ? this.deps.codeEmbedding : this.deps.knowledgeEmbedding;
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
    const currentTarget = this.deps.semanticStore.getProfile(purpose)?.embedding_target;
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
    await this.recoverPendingCleanupJobs(purpose);
    await this.recoverAbandonedBuildingGenerations(purpose);
    this.assertSingleActiveGenerationPerFile(purpose);
    const { vector } = await embedding.embedQuery('semantic generation dimension probe');
    const fingerprintAfterProbe = embedding.fingerprint?.() ?? `semantic:${purpose}:unknown`;
    const targetAfterProbe = this.deps.semanticStore.getProfile(purpose)?.embedding_target;
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
    const spaceFingerprint = `${baseFingerprint}:space-dimension:${vector.length}`;
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
  }

  /** A third vector space cannot be introduced while two older generations
   * are still actively serving different namespaces from the same table file.
   * Finish the prior namespace-by-namespace rollout first; otherwise atomic
   * activation and the two-table bound would be mutually exclusive. */
  private assertSingleActiveGenerationPerFile(purpose: SemanticPurpose): void {
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
  }

  private workerDropGeneration(namespace: string, generationId: number): Promise<void> {
    const drop = this.deps.vectorStore.dropGeneration;
    if (!drop) throw new SemanticVectorWorkerUnavailableError('generation cleanup');
    return drop.call(this.deps.vectorStore, namespace, generationId);
  }

  private workerListIds(namespace: string, generationId: number): Promise<string[]> {
    const list = this.deps.vectorStore.listIds;
    if (!list) throw new SemanticVectorWorkerUnavailableError('physical coverage probe');
    return list.call(this.deps.vectorStore, namespace, generationId);
  }

  private workerDeleteIds(
    namespace: string,
    generationId: number,
    ids: string[],
  ): Promise<number> {
    const remove = this.deps.vectorStore.deleteByIdsForGeneration;
    if (!remove) throw new SemanticVectorWorkerUnavailableError('generation-scoped vector deletion');
    return remove.call(this.deps.vectorStore, namespace, generationId, ids);
  }

  private workerDeleteItemKeys(
    namespace: string,
    generationId: number,
    itemKeys: string[],
  ): Promise<number> {
    const remove = this.deps.vectorStore.deleteByItemKeysForGeneration;
    if (!remove) throw new SemanticVectorWorkerUnavailableError('generation-scoped item deletion');
    return remove.call(this.deps.vectorStore, namespace, generationId, itemKeys);
  }

  private workerRemoveProject(projectId: number): Promise<void> {
    const remove = this.deps.vectorStore.removeProject;
    if (!remove) throw new SemanticVectorWorkerUnavailableError('project vector removal');
    return remove.call(this.deps.vectorStore, projectId);
  }

  /** Retry durable cleanup jobs before allowing a new generation. A DROP is
   * idempotent, so a crash after the physical operation but before the job
   * update is recovered safely on the next attempt. */
  private async recoverPendingCleanupJobs(purpose: SemanticPurpose): Promise<void> {
    const jobs = this.deps.semanticStore.listJobs()
      .filter((job) => job.kind === 'cleanup'
        && (job.status === 'pending' || job.status === 'paused' || job.status === 'running'))
      .filter((job) => job.generation_id
        && this.deps.semanticStore.getGeneration(job.generation_id)?.purpose === purpose);
    for (const job of jobs) await this.performCleanupJob(job);
  }

  /** Remove a non-serving construction table before allocating its
   * replacement. If any namespace in the same SQLite already serves that
   * table, the prior rollout must be completed instead of destructively
   * rolling it back. */
  private async recoverAbandonedBuildingGenerations(purpose: SemanticPurpose): Promise<void> {
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
  }

  private async performCleanupJob(job: SemanticJobRow): Promise<number> {
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
  }

  private assertNamespaceProjectActive(namespace: string): void {
    const projectId = projectIdFromSemanticNamespace(namespace);
    if (projectId === null) return;
    if (this.projectTombstones.has(projectId)) {
      throw new Error(`Project ${projectId} semantic index is being removed`);
    }
    if (!this.deps.db.getProject(projectId)) {
      throw new Error(`Project ${projectId} not found`);
    }
  }

  private prepareNamespaceGeneration(
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

  private async buildCodeNamespace(
    projectId: number,
    generation: SemanticGenerationRow,
    force: boolean,
  ): Promise<void> {
    const namespace = codeNamespace(projectId);
    this.assertNamespaceProjectActive(namespace);
    const project = this.deps.db.getProject(projectId);
    if (!project) throw new Error(`Project ${projectId} not found`);
    const before = this.deps.semanticStore.listNamespaceGenerations({ namespace })[0];
    const incrementalActive = !force && before?.active_generation_id === generation.id;
    const resumableDeltaJobs = this.captureCodeDeltaJobs(namespace, generation.id, !incrementalActive);
    if (incrementalActive) {
      await this.drainActiveCodeDeltas(projectId, project.root_path, generation, resumableDeltaJobs);
      return;
    }
    const expected = this.deps.db.listFiles(projectId).length;
    this.prepareNamespaceGeneration(namespace, 'code', generation.id, expected);
    const deltaJobs = resumableDeltaJobs;
    for (const deltaJob of deltaJobs) {
      this.deps.semanticStore.updateJob(deltaJob.id, { status: 'running', error: null });
    }
    const jobKind = before?.active_generation_id ? 'build' as const : 'backfill' as const;
    const interruptedJob = this.deps.semanticStore.listJobs({ namespace }).find((candidate) =>
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
      const result = await this.runCodeEmbedding(projectId, project.root_path, namespace, job.id);
      if (result.failedBatches > 0) throw new Error(`${result.failedBatches} embedding batch(es) failed`);
      if (result.skipped > 0) throw new Error(`${result.skipped} source file(s) disappeared during embedding`);

      // Jobs present at the start correspond to structural events already
      // drained before this catch-up. Any job enqueued during embedding still
      // points at not-yet-reconciled structural state and blocks activation.
      const capturedIds = new Set(deltaJobs.map((deltaJob) => deltaJob.id));
      const newerDelta = this.deps.semanticStore.listJobs({ namespace }).some((candidate) =>
        candidate.kind === 'delta'
        && candidate.generation_id === generation.id
        && !capturedIds.has(candidate.id)
        && (candidate.status === 'pending' || candidate.status === 'paused' || candidate.status === 'running'));
      if (newerDelta) throw new DeltaBuildPendingError(namespace);

      const verifiedItems = await this.verifyCodeVectorCoverage(
        projectId,
        project.root_path,
        generation.id,
        namespace,
      );
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
      if (error instanceof EmbeddingPauseRequestedError) {
        for (const deltaJob of deltaJobs) {
          const current = this.deps.semanticStore.getJob(deltaJob.id);
          if (current?.status !== 'completed') {
            this.deps.semanticStore.updateJob(deltaJob.id, {
              status: 'paused', failed_items: 0, error: 'paused because project is not active',
            });
          }
        }
        this.deps.semanticStore.updateNamespaceProgress(namespace, {
          failed_items: 0,
          last_error: null,
        });
        this.deps.semanticStore.updateJob(job.id, {
          status: 'paused', failed_items: 0, error: 'paused because project is not active',
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
  }

  private async drainActiveCodeDeltas(
    projectId: number,
    rootPath: string,
    generation: SemanticGenerationRow,
    initial: SemanticJobRow[],
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
        let indexedItems: number;
        if (wildcard) {
          const result = await this.runCodeEmbedding(
            projectId, rootPath, namespace, captured[0].id, undefined, false,
          );
          if (result.failedBatches > 0) {
            throw new Error(`${result.failedBatches} embedding batch(es) failed`);
          }
          indexedItems = await this.verifyCodeVectorCoverage(
            projectId, rootPath, generation.id, namespace,
          );
        } else {
          const latestByPath = new Map(cursor.events.map((event) => [event.path, event]));
          const upsertPaths = [...latestByPath.values()]
            .filter((event) => event.kind === 'upsert')
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
              projectId, rootPath, namespace, captured[0].id, upsertPaths, false,
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
        const paused = error instanceof EmbeddingPauseRequestedError;
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
  }

  private captureCodeDeltaJobs(
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
    const jobs = this.deps.semanticStore.listJobs({ namespace }).filter(relevant);
    for (const job of jobs) {
      if (job.status !== 'running') continue;
      this.deps.semanticStore.updateJob(job.id, {
        status: 'pending',
        processed_items: 0,
        failed_items: 0,
        error: null,
      });
    }
    return this.deps.semanticStore.listJobs({ namespace }).filter((candidate) =>
      relevant(candidate) && (candidate.status === 'pending' || candidate.status === 'paused'));
  }

  private runCodeEmbedding(
    projectId: number,
    rootPath: string,
    _namespace: string,
    jobId: number | null,
    paths?: readonly string[],
    reportNamespaceProgress = true,
  ) {
    return retryEmbeddings({
      db: this.deps.db,
      embeddingService: this.deps.codeEmbedding,
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
      shouldPause: () => this.shouldPauseCodeProject(projectId),
      ...(paths ? { paths } : {}),
    });
  }

  /** Rebuild and validate the manifest in bounded waves. Only lightweight ids
   * survive a wave; file contents and EmbeddingCandidate objects are released
   * before the next disk read, avoiding a second whole-project RAM spike after
   * the wave-based embedding pass. */
  private async verifyCodeVectorCoverage(
    projectId: number,
    rootPath: string,
    generationId: number,
    namespace: string,
  ): Promise<number> {
    const project = this.deps.db.getProject(projectId);
    if (!project) throw new Error(`Project ${projectId} not found during vector verification`);
    const dbFiles = this.deps.db.listFiles(projectId);
    const generationFingerprint = this.deps.semanticStore.getGeneration(generationId)?.fingerprint;
    const fingerprint = generationFingerprint
      ? embeddingFingerprintForGeneration(generationFingerprint)
      : this.deps.codeEmbedding.fingerprint?.() ?? 'embedding:unknown';
    const expectedIdentities = new Set<string>();
    const expectedKeys = new Set<string>();

    for (let offset = 0; offset < dbFiles.length; offset += CODE_VERIFY_WAVE_FILES) {
      const files: CandidateFile[] = [];
      for (const file of dbFiles.slice(offset, offset + CODE_VERIFY_WAVE_FILES)) {
        let content: string;
        try { content = readFileSync(join(rootPath, file.path), 'utf-8'); }
        catch { throw new Error(`vector coverage incomplete: source file disappeared: ${file.path}`); }
        const symbols = this.deps.db.getSymbolsByFile(projectId, file.path);
        files.push({
          path: file.path,
          fileId: file.id,
          language: file.language,
          symbols: symbols.map((symbol) => ({
            id: symbol.id,
            stable_id: symbol.stable_id,
            name: symbol.name,
            kind: symbol.kind,
            signature: symbol.signature,
            comment: symbol.comment,
            line: symbol.line,
            end_line: symbol.end_line,
            parent: symbol.parent,
          })),
          content,
        });
      }
      const expected = buildEmbeddingCandidates(
        this.deps.db,
        { id: project.id, name: project.name },
        files,
        [],
        fingerprint,
      );
      const waveItemKeys = semanticItemKeysForCandidateFiles(this.deps.db, projectId, files);
      const waveItems = this.deps.semanticStore.listItems({
        generation_id: generationId,
        namespace,
        item_keys: waveItemKeys,
      });
      const actual = new Map<string, (typeof waveItems)[number]>();
      for (const item of waveItems) {
        const identity = `${item.item_key}\0${item.chunk_index}`;
        if (actual.has(identity)) throw new Error(`vector coverage incomplete: duplicate item ${item.item_key}`);
        actual.set(identity, item);
      }
      for (const candidate of expected) {
        const itemKey = `${candidate.metadata.type ?? 'vector'}:${candidate.metadata.ref_id ?? candidate.id}`;
        const chunkIndex = Number(candidate.metadata.chunk_index ?? 0) || 0;
        const identity = `${itemKey}\0${chunkIndex}`;
        const item = actual.get(identity);
        if (!item
          || item.status !== 'indexed'
          || item.vector_id !== candidate.id
          || item.source_hash !== candidate.hash) {
          throw new Error(`vector coverage incomplete: ${itemKey}#${chunkIndex} is not current`);
        }
        expectedIdentities.add(identity);
        expectedKeys.add(itemKey);
      }
    }

    let items = this.deps.semanticStore.listItems({ generation_id: generationId, namespace });
    const obsoleteKeys = [...new Set(items
      .filter((item) => !expectedKeys.has(item.item_key))
      .map((item) => item.item_key))];
    if (obsoleteKeys.length > 0) {
      await this.workerDeleteItemKeys(namespace, generationId, obsoleteKeys);
    }
    const obsoleteIds = items.flatMap((item) =>
      item.vector_id && expectedKeys.has(item.item_key)
        && !expectedIdentities.has(`${item.item_key}\0${item.chunk_index}`)
        ? [item.vector_id]
        : []);
    if (obsoleteIds.length > 0) {
      await this.workerDeleteIds(namespace, generationId, obsoleteIds);
      try { await this.deps.lshSink.afterDelete?.(projectId, obsoleteIds); }
      catch { /* LSH cleanup is best-effort. */ }
    }
    if (obsoleteKeys.length > 0 || obsoleteIds.length > 0) {
      items = this.deps.semanticStore.listItems({ generation_id: generationId, namespace });
    }
    const actual = new Set<string>();
    for (const item of items) {
      const key = `${item.item_key}\0${item.chunk_index}`;
      if (actual.has(key)) throw new Error(`vector coverage incomplete: duplicate item ${item.item_key}`);
      if (item.status !== 'indexed' || !item.vector_id) {
        throw new Error(`vector coverage incomplete: ${item.item_key}#${item.chunk_index} is not indexed`);
      }
      actual.add(key);
    }
    if (actual.size !== expectedIdentities.size
      || [...expectedIdentities].some((identity) => !actual.has(identity))) {
      throw new Error(`vector coverage incomplete: found ${actual.size}/${expectedIdentities.size} exact code items`);
    }
    await this.verifyPhysicalVectorIds(
      namespace,
      generationId,
      items.flatMap((item) => item.vector_id ? [item.vector_id] : []),
    );
    return expectedIdentities.size;
  }

  private async buildDocsNamespace(collectionId: number, generation: SemanticGenerationRow, force: boolean): Promise<void> {
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
        this.prepareNamespaceGeneration(namespace, 'knowledge', generation.id, total);
      }
      const job = this.deps.semanticStore.createJob({
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
  }

  private async verifyDocsVectorCoverage(
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

  private async buildSnapshotNamespace(projectId: number, generation: SemanticGenerationRow, force: boolean): Promise<void> {
    const namespace = snapshotNamespace(projectId);
    this.assertNamespaceProjectActive(namespace);
    for (let pass = 0; pass < 3; pass++) {
      if (this.hasLiveKnowledgeMutationFence(namespace)) {
        throw new DeltaBuildPendingError(namespace);
      }
      const before = this.deps.semanticStore.listNamespaceGenerations({ namespace })[0];
      const captured = this.captureKnowledgeMutationJobs(namespace);
      if (!force
        && before?.active_generation_id === generation.id
        && before.delta_items === 0
        && captured.length === 0) return;
      const total = this.deps.db.listSnapshotsForSemanticIndex(projectId).length;
      const activating = before?.active_generation_id !== generation.id;
      if (activating) this.prepareNamespaceGeneration(namespace, 'knowledge', generation.id, total);
      const job = this.deps.semanticStore.createJob({
        generation_id: generation.id,
        namespace,
        kind: before?.active_generation_id ? 'build' : 'backfill',
        expected_items: total,
      });
      this.deps.semanticStore.updateJob(job.id, { status: 'running' });
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
  }

  private async buildMemoryNamespace(
    scope: 'project' | 'user',
    projectId: number,
    generation: SemanticGenerationRow,
    force: boolean,
  ): Promise<void> {
    const namespace = scope === 'user' ? userMemoryNamespace() : projectMemoryNamespace(projectId);
    this.assertNamespaceProjectActive(namespace);
    for (let pass = 0; pass < 3; pass++) {
      if (this.hasLiveKnowledgeMutationFence(namespace)) {
        throw new DeltaBuildPendingError(namespace);
      }
      const before = this.deps.semanticStore.listNamespaceGenerations({ namespace })[0];
      const captured = this.captureKnowledgeMutationJobs(namespace);
      if (!force
        && before?.active_generation_id === generation.id
        && before.delta_items === 0
        && captured.length === 0) return;
      const investigationRows = scope === 'project'
        ? this.deps.investigationSemanticIndex.listProject(projectId)
        : [];
      const total = this.memorySourceRows(scope, projectId).length + investigationRows.length;
      const activating = before?.active_generation_id !== generation.id;
      if (activating) this.prepareNamespaceGeneration(namespace, 'knowledge', generation.id, total);
      const job = this.deps.semanticStore.createJob({
        generation_id: generation.id,
        namespace,
        kind: before?.active_generation_id ? 'build' : 'backfill',
        expected_items: total,
      });
      this.deps.semanticStore.updateJob(job.id, { status: 'running' });
      try {
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
        if (failed > 0) throw new Error(`memory embedding failed for ${failed}/${total} source(s)`);
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
  }

  /** Capture settled documentation mutations while leaving live relational
   * fences untouched. Generation-less backfills and interrupted execution
   * deltas are also part of the watermark because a full collection pass
   * reconciles their source state. */
  private captureDocsMutationJobs(namespace: string): SemanticJobRow[] {
    const relevant = (job: SemanticJobRow): boolean =>
      job.namespace === namespace
      && (job.kind === 'delta' || (job.kind === 'backfill' && job.generation_id === null))
      && (job.status === 'pending' || job.status === 'paused' || job.status === 'running');
    const isLiveFence = (job: SemanticJobRow): boolean =>
      job.status === 'running'
      && job.cursor?.reason === 'mutation-fence'
      && job.cursor?.fence_phase === 'in-flight';

    for (const job of this.deps.semanticStore.listJobs({ namespace }).filter(relevant)) {
      if (isLiveFence(job) || job.status !== 'running') continue;
      // A non-fence running delta/backfill was interrupted before it could
      // commit its watermark. Return it to pending before claiming this pass.
      this.deps.semanticStore.updateJob(job.id, {
        status: 'pending', processed_items: 0, failed_items: 0, error: null,
      });
    }
    const captured = this.deps.semanticStore.listJobs({ namespace })
      .filter((job) => relevant(job) && !isLiveFence(job));
    for (const job of captured) {
      this.deps.semanticStore.updateJob(job.id, {
        status: 'running', processed_items: 0, failed_items: 0, error: null,
      });
    }
    return captured.map((job) => this.deps.semanticStore.getJob(job.id) ?? job);
  }

  private hasOpenDocsMutationJobs(namespace: string): boolean {
    return this.deps.semanticStore.listJobs({ namespace }).some((job) =>
      (job.kind === 'delta' || (job.kind === 'backfill' && job.generation_id === null))
      && (job.status === 'pending' || job.status === 'paused' || job.status === 'running'));
  }

  private hasLiveDocsMutationFence(namespace: string): boolean {
    return this.deps.semanticStore.listJobs({ namespace }).some((job) =>
      job.kind === 'delta'
      && job.status === 'running'
      && job.cursor?.reason === 'mutation-fence'
      && job.cursor?.fence_phase === 'in-flight');
  }

  /** Capture the durable watermark for a full snapshot/memory pass. Running
   * jobs are crash residue because namespace execution is serialized; return
   * them to pending before claiming the immutable watermark. */
  private captureKnowledgeMutationJobs(namespace: string): SemanticJobRow[] {
    const relevant = (job: SemanticJobRow): boolean =>
      job.namespace === namespace
      && (job.kind === 'delta' || (job.kind === 'backfill' && job.generation_id === null))
      && (job.status === 'pending' || job.status === 'paused' || job.status === 'running');
    const isLiveFence = (job: SemanticJobRow): boolean =>
      job.kind === 'delta'
      && job.status === 'running'
      && job.cursor?.reason === 'mutation-fence'
      && job.cursor?.fence_phase === 'in-flight';
    for (const job of this.deps.semanticStore.listJobs({ namespace }).filter(relevant)) {
      if (job.status !== 'running') continue;
      if (isLiveFence(job)) continue;
      this.deps.semanticStore.updateJob(job.id, {
        status: 'pending', processed_items: 0, failed_items: 0, error: null,
      });
    }
    const captured = this.deps.semanticStore.listJobs({ namespace })
      .filter((job) => relevant(job) && !isLiveFence(job));
    for (const job of captured) {
      this.deps.semanticStore.updateJob(job.id, {
        status: 'running', processed_items: 0, failed_items: 0, error: null,
      });
    }
    return captured.map((job) => this.deps.semanticStore.getJob(job.id) ?? job);
  }

  private hasLiveKnowledgeMutationFence(namespace: string): boolean {
    return this.deps.semanticStore.listJobs({ namespace }).some((job) =>
      job.kind === 'delta'
      && job.status === 'running'
      && job.cursor?.reason === 'mutation-fence'
      && job.cursor?.fence_phase === 'in-flight');
  }

  private async verifySnapshotVectorCoverage(
    projectId: number,
    generationId: number,
    namespace: string,
  ): Promise<number> {
    const generationFingerprint = this.deps.semanticStore.getGeneration(generationId)?.fingerprint;
    const fingerprint = generationFingerprint
      ? embeddingFingerprintForGeneration(generationFingerprint)
      : this.deps.knowledgeEmbedding.fingerprint?.() ?? 'embedding:unknown';
    const expected = new Map<string, string>();
    for (const snapshot of this.deps.db.listSnapshotsForSemanticIndex(projectId)) {
      const hash = snapshotEmbeddingTextHash(snapshot, fingerprint);
      const chunks = snapshotEmbeddingTexts(snapshot).length;
      for (let index = 0; index < chunks; index++) {
        expected.set(`snapshot:${snapshot.id}\0${index}`, hash);
      }
    }
    return this.verifyKnowledgeItems(generationId, namespace, expected, 'snapshot');
  }

  private memorySourceRows(scope: 'project' | 'user', projectId: number) {
    if (scope === 'user') return this.deps.db.listAgentMemoryForSemanticIndex('user', 0);
    return [
      ...this.deps.db.listAgentMemoryForSemanticIndex('project', projectId),
      ...this.deps.db.listAgentMemoryForSemanticIndex('local', projectId),
    ];
  }

  private async verifyMemoryVectorCoverage(
    scope: 'project' | 'user',
    projectId: number,
    generationId: number,
    namespace: string,
  ): Promise<number> {
    const generationFingerprint = this.deps.semanticStore.getGeneration(generationId)?.fingerprint;
    const fingerprint = generationFingerprint
      ? embeddingFingerprintForGeneration(generationFingerprint)
      : this.deps.knowledgeEmbedding.fingerprint?.() ?? 'embedding:unknown';
    const expected = new Map<string, string>();
    for (const memory of this.memorySourceRows(scope, projectId)) {
      const hash = agentMemoryEmbeddingTextHash(memory, fingerprint);
      const chunks = agentMemoryEmbeddingTexts(memory).length;
      for (let index = 0; index < chunks; index++) {
        expected.set(`agent_memory:${memory.id}\0${index}`, hash);
      }
    }
    if (scope === 'project') {
      for (const investigation of this.deps.investigationSemanticIndex.listProject(projectId)) {
        expected.set(
          `investigation:${investigation.id}\0${0}`,
          investigationEmbeddingTextHash(investigation, fingerprint),
        );
      }
    }
    return this.verifyKnowledgeItems(generationId, namespace, expected, 'memory');
  }

  private async verifyKnowledgeItems(
    generationId: number,
    namespace: string,
    expected: ReadonlyMap<string, string>,
    label: string,
  ): Promise<number> {
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
      throw new Error(`${label} vector coverage incomplete: duplicate semantic item`);
    }
    for (const [identity, hash] of expected) {
      const item = actual.get(identity);
      if (!item || item.status !== 'indexed' || !item.vector_id || item.source_hash !== hash) {
        throw new Error(`${label} vector coverage incomplete: ${identity.replace('\0', '#')} is not current`);
      }
    }
    if (actual.size !== expected.size) {
      throw new Error(`${label} vector coverage incomplete: found ${actual.size}/${expected.size} exact items`);
    }
    await this.verifyPhysicalVectorIds(
      namespace,
      generationId,
      items.flatMap((item) => item.vector_id ? [item.vector_id] : []),
    );
    return expected.size;
  }

  /** The central ledger is necessary but not sufficient: a crash can leave an
   * indexed semantic_item without its sqlite-vec row (or vice versa). Compare
   * exact id sets immediately before the atomic namespace switch. */
  private async verifyPhysicalVectorIds(
    namespace: string,
    generationId: number,
    expectedIds: readonly string[],
  ): Promise<void> {
    const physicalIds = await this.workerListIds(namespace, generationId);
    const expected = new Set(expectedIds);
    const physical = new Set(physicalIds);
    if (expected.size !== expectedIds.length) {
      throw new Error(`physical vector coverage incomplete: duplicate ledger id in ${namespace}`);
    }
    if (physical.size !== physicalIds.length) {
      throw new Error(`physical vector coverage incomplete: duplicate sqlite-vec id in ${namespace}`);
    }
    const missing = [...expected].filter((id) => !physical.has(id));
    const extra = [...physical].filter((id) => !expected.has(id));
    // Heal crash residue deterministically while keeping this activation
    // attempt closed. Orphan physical rows can be removed immediately;
    // ledger rows whose vectors vanished are removed so the durable retry
    // embeds them again instead of trusting a stale "indexed" marker.
    if (extra.length > 0) await this.workerDeleteIds(namespace, generationId, extra);
    if (missing.length > 0) {
      this.deps.semanticStore.deleteItemsByVectorIds(generationId, namespace, missing);
    }
    if (missing.length === 0 && extra.length > 0) {
      const reconciled = new Set(await this.workerListIds(namespace, generationId));
      if (reconciled.size === expected.size && [...expected].every((id) => reconciled.has(id))) return;
    }
    if (missing.length > 0 || extra.length > 0) {
      const detail = [
        missing.length ? `missing ${missing.slice(0, 3).join(', ')}` : '',
        extra.length ? `extra ${extra.slice(0, 3).join(', ')}` : '',
      ].filter(Boolean).join('; ');
      throw new Error(
        `physical vector coverage incomplete for ${namespace}: ${physical.size}/${expected.size} ids${detail ? ` (${detail})` : ''}`,
      );
    }
  }

  private async completeNamespace(
    namespace: string,
    generationId: number,
    jobId: number,
    indexed: number,
    expected: number,
    previousActiveGenerationId: number | null,
  ): Promise<void> {
    // A missing/failed vector write must never be hidden by reducing the
    // expected count to whatever happened to land. Empty source scopes are
    // valid; non-empty scopes require full coverage.
    if (indexed < expected) {
      throw new Error(`vector coverage incomplete: ${indexed}/${expected} items`);
    }
    this.deps.semanticStore.updateNamespaceProgress(namespace, {
      expected_items: expected, indexed_items: expected, failed_items: 0, last_error: null,
    });
    this.deps.semanticStore.activateNamespaceGeneration(namespace, generationId);
    this.deps.semanticStore.updateJob(jobId, {
      status: 'completed', processed_items: expected, failed_items: 0, error: null,
    });
    await this.cleanupGenerationIfUnreferenced(namespace, previousActiveGenerationId);
  }

  /** Drop an obsolete generation table only when no active/building namespace
   * in the same physical SQLite still points at it. Knowledge namespaces can
   * share a table (snapshots + project memory, or multiple doc collections),
   * so a global reference check alone is either too early or unnecessarily
   * late. The physical table key also deduplicates concurrent cleanup RPCs. */
  private async cleanupGenerationIfUnreferenced(
    namespace: string,
    generationId: number | null,
  ): Promise<void> {
    if (!generationId) return;
    let target: ReturnType<LocalVectorRouter['resolve']>;
    try {
      target = this.deps.router.resolve(namespace, generationId);
    } catch {
      return;
    }
    const key = `${target.dbPath.toLowerCase()}\0${target.tableName}`;
    const running = this.cleanupRuns.get(key);
    if (running) return running;

    const cleanup = (async (): Promise<void> => {
      const referenced = this.deps.semanticStore.listNamespaceGenerations({ purpose: target.purpose })
        .some((row) => {
          if (row.active_generation_id !== generationId && row.building_generation_id !== generationId) return false;
          try {
            const route = this.deps.router.resolve(row.namespace, generationId);
            return route.dbPath.toLowerCase() === target.dbPath.toLowerCase()
              && route.tableName === target.tableName;
          } catch {
            // An unresolved namespace is conservatively considered a
            // reference: never delete a table we cannot prove is orphaned.
            return true;
          }
        });
      if (referenced) return;

      const job = this.deps.semanticStore.createJob({
        generation_id: generationId,
        namespace,
        kind: 'cleanup',
        priority: -10,
        cursor: {
          reason: 'unreferenced',
          cleanup_namespaces: this.deps.semanticStore.listGenerationNamespaces(generationId)
            .filter((candidateNamespace) => {
              try {
                const route = this.deps.router.resolve(candidateNamespace, generationId);
                return route.dbPath.toLowerCase() === target.dbPath.toLowerCase()
                  && route.tableName === target.tableName;
              } catch {
                return false;
              }
            }),
          db_path: target.dbPath,
          table_name: target.tableName,
        },
      });
      try {
        await this.performCleanupJob(job);
      } catch (error) {
        const message = errorMessage(error);
        console.warn(`[semantic] generation cleanup paused for ${namespace} g${generationId}: ${message}`);
      }
    })();
    const tracked = cleanup.finally(() => {
      if (this.cleanupRuns.get(key) === tracked) this.cleanupRuns.delete(key);
    });
    this.cleanupRuns.set(key, tracked);
    return tracked;
  }

  private pauseNamespace(namespace: string, jobId: number, error: unknown): void {
    const message = errorMessage(error);
    this.deps.semanticStore.updateNamespaceProgress(namespace, { failed_items: 1, last_error: message });
    this.deps.semanticStore.updateJob(jobId, { status: 'paused', failed_items: 1, error: message });
  }

  private refreshGenerationProgress(generationId: number): void {
    const generation = this.deps.semanticStore.getGeneration(generationId);
    if (!generation) return;
    const rows = this.deps.semanticStore.listNamespaceGenerations().filter((row) =>
      (row.active_generation_id === generationId || row.building_generation_id === generationId)
      && this.allowsNamespaceMutation(row.namespace));
    // Generations are reusable vector spaces, not global rollout mandates.
    // On-demand indexing may legitimately target one project/collection; only
    // namespaces that reference this generation participate in its readiness.
    const complete = rows.length > 0 && rows.every((row) => {
      return row
        && row.active_generation_id === generationId
        && row.building_generation_id === null
        && row.failed_items === 0
        && row.delta_items === 0
        && row.indexed_items >= row.expected_items;
    });
    const failedItems = rows.reduce((sum, row) => sum + row.failed_items, 0);
    this.deps.semanticStore.updateGeneration(generationId, {
      expected_items: rows.reduce((sum, row) => sum + row.expected_items, 0),
      indexed_items: rows.reduce((sum, row) => sum + row.indexed_items, 0),
      failed_items: failedItems,
      status: complete ? 'ready' : 'building',
      error: complete ? null : rows.find((row) => row.last_error)?.last_error ?? null,
    });
  }

  private serial(
    namespace: string,
    operation: () => Promise<void>,
    allowProjectRemoval = false,
  ): Promise<void> {
    const previous = this.locks.get(namespace) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(async () => {
      if (!allowProjectRemoval && !this.allowsNamespaceMutation(namespace)) return;
      await operation();
    });
    const tracked = current.finally(() => {
      if (this.locks.get(namespace) === tracked) this.locks.delete(namespace);
    });
    this.locks.set(namespace, tracked);
    return tracked;
  }
}
