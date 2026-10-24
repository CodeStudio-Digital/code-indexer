import { WorkerHost } from '@mcp/orchestrator-host';
import { randomUUID } from 'node:crypto';
import type { VectorMatch, VectorRecord } from '@mcp/shared/types.js';
import type {
  VectorItemState,
  VectorSearchOptions,
  VectorStore,
  VectorWriteTarget,
} from '@mcp/store/vectors.js';
import { resolveWorkerFile, type ResolvedWorker } from './workerFileResolution.js';
import type { EmbeddingService } from '@mcp/indexer/search/embeddings.js';
import type {
  RerankCandidate,
  RerankRequestOptions,
  RerankResult,
  RerankerService,
} from '@mcp/indexer/search/reranker-types.js';
import type {
  EmbeddingTarget,
  RerankerTarget,
  SemanticStore,
  SemanticJobRow,
} from '@mcp/store/semantic-store.js';
import { localEmbeddingFingerprint } from '@mcp/indexer/search/local-embeddings.js';
import type { ProjectJobScope, ProjectJobsPageInput, ProjectJobsPage } from './semantic-job-query-port.js';

const REQUEST_TIMEOUT_MS = 120_000;
const DEFAULT_IDLE_MS = 5 * 60_000;
const IDLE_PROBE_TIMEOUT_MS = 5_000;
const RERANKER_DIAGNOSTICS_CACHE_MS = 1_000;

interface SemanticWorkerIdleState {
  activeOperations: number;
  active: boolean;
  queued: number;
}

interface SemanticRerankerDiagnostics {
  policy: 'auto' | 'explicit';
  requested_model: string;
  resolved_model: string | null;
  dtype: string;
  estimated_peak_bytes: number;
  reserve_bytes: number;
  execution_provider: string;
  downgrade_reason: string | null;
  last_latency_ms: number | null;
  enabled: boolean;
  total_memory_bytes: number;
  available_memory_bytes: number;
  cpu_cores: number;
  active: boolean;
  queued: number;
}

/** RPC facade for the semantic vector worker. The main/Electron process never
 * opens sqlite-vec handles, so search/checkpoint work cannot block the UI. */
export class SemanticVectorWorkerClient implements VectorStore {
  private host: WorkerHost | null = null;
  private inflight = 0;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private evicting: Promise<void> | null = null;
  private readonly rerankerDiagnosticCache = new Map<string, {
    diagnostics: SemanticRerankerDiagnostics;
    updatedAt: number;
  }>();
  private readonly rerankerDiagnosticInflight = new Map<
    string,
    Promise<SemanticRerankerDiagnostics>
  >();

  constructor(
    private readonly dbPath: string,
    private readonly resolved: ResolvedWorker,
  ) {}

  static create(dbPath: string): SemanticVectorWorkerClient {
    const resolved = resolveWorkerFile(import.meta.url, 'semantic-vector-worker');
    if (!resolved) throw new Error('semantic vector worker entry not found');
    return new SemanticVectorWorkerClient(dbPath, resolved);
  }

  projectJobsPage(input: ProjectJobsPageInput, signal?: AbortSignal): Promise<ProjectJobsPage> {
    return this.request('semantic.projectJobsPage', input, signal);
  }

  currentProjectJobs(scopes: ProjectJobScope[], signal?: AbortSignal): Promise<Array<SemanticJobRow | null>> {
    return this.request('semantic.currentProjectJobs', scopes, signal);
  }

  /** Bounded RPC pages keep SQLite scans and cursor JSON decoding off main. */
  async listSemanticJobs(filter: Parameters<SemanticStore['listJobs']>[0] = {}): Promise<SemanticJobRow[]> {
    const jobs: SemanticJobRow[] = [];
    let afterId = filter.afterId ?? 0;
    let throughId = filter.throughId;
    do {
      const page = await this.request<{ throughId: number; jobs: SemanticJobRow[] }>(
        'semantic.jobsPage', { filter, afterId, throughId },
      );
      if (!Number.isSafeInteger(page.throughId) || page.throughId < 0
        || (throughId !== undefined && page.throughId !== throughId)
        || page.jobs.length > 256) throw new Error('invalid semantic jobs page');
      throughId = page.throughId;
      for (const job of page.jobs) {
        if (!Number.isSafeInteger(job.id) || job.id <= afterId || job.id > throughId) {
          throw new Error('semantic job cursor did not advance');
        }
        afterId = job.id;
        jobs.push(job);
      }
      if (page.jobs.length < 256 || afterId >= throughId) break;
    } while (true);
    jobs.sort((a, b) => filter.order === 'newest' ? b.id - a.id : b.priority - a.priority || a.id - b.id);
    return filter.limit === undefined ? jobs : jobs.slice(0, filter.limit);
  }

  /** ONNX proxy used by SemanticProfileRuntime. There is deliberately no
   * in-process fallback: if the worker fails, the coordinator pauses and
   * queries fall back to FTS instead of loading weights in Electron main. */
  embeddingService(
    target: Extract<EmbeddingTarget, { kind: 'onnx' }>,
  ): EmbeddingService {
    return {
      embed: (texts) => texts.length === 0
        ? Promise.resolve({ vectors: [], tokens: 0 })
        : this.request('inference.embed', { target, texts }),
      embedQuery: (text, options) => this.request('inference.embedQuery', {
        target, text, supersessionKey: options?.supersessionKey,
      }, options?.signal),
      fingerprint: () => localEmbeddingFingerprint({
        model: target.model,
        revision: target.revision,
        dtype: target.dtype,
        protocol: {
          pooling: target.pooling,
          normalize: target.normalize,
          queryTemplate: target.queryTemplate,
          documentTemplate: target.documentTemplate,
          maxTokens: target.maxTokens,
        },
      }),
      maxConcurrency: () => 1,
      diagnostics: () => ({
        model: target.model,
        dtype: target.dtype ?? 'q8',
        loaded: this.host?.isRunning() === true,
        owner: 'semantic-worker',
      }),
      // The runtime caches several proxies over one worker. Disposing one
      // profile must not evict sessions still serving the other profile.
      dispose: async () => undefined,
    } as EmbeddingService;
  }

  rerankerService(
    target: Extract<RerankerTarget, { kind: 'onnx' }>,
  ): RerankerService {
    return {
      name: 'semantic-worker-local',
      cacheRevision: () => `semantic-worker-reranker:${JSON.stringify({
        ...target,
        dtype: target.dtype ?? 'q8',
      })}`,
      rerank: (
        query: string,
        candidates: RerankCandidate[],
        topK = 10,
        options?: RerankRequestOptions,
      ): Promise<RerankResult[]> => {
        if (candidates.length === 0) return Promise.resolve([]);
        return this.request<{
          results: RerankResult[];
          diagnostics: SemanticRerankerDiagnostics;
        }>('inference.rerank', {
          target,
          query,
          candidates,
          topK,
          supersessionKey: options?.supersessionKey,
        }, options?.signal).then((response) => {
          this.rerankerDiagnosticCache.set(JSON.stringify(target), {
            diagnostics: response.diagnostics,
            updatedAt: Date.now(),
          });
          return response.results;
        });
      },
      diagnostics: () => this.rerankerDiagnostics(target),
      // The worker resolves 20/40/64 from live hardware. Retain the largest
      // possible pool here so the main-side candidate pipeline never clips a
      // medium-tier policy to its generic topK x2 default.
      candidatePoolSize: (topK) => Math.max(topK, 64),
      dispose: async () => undefined,
    };
  }

  rerankerDiagnostics(
    target: Extract<RerankerTarget, { kind: 'onnx' }>,
  ): Promise<SemanticRerankerDiagnostics> {
    const key = JSON.stringify(target);
    const cached = this.rerankerDiagnosticCache.get(key);
    if (cached && Date.now() - cached.updatedAt <= RERANKER_DIAGNOSTICS_CACHE_MS) {
      return Promise.resolve(cached.diagnostics);
    }
    const inflight = this.rerankerDiagnosticInflight.get(key);
    if (inflight) return inflight;

    // Always resolve policy and hardware in the semantic worker. This RPC does
    // not construct a LocalReranker or load weights; it only returns metadata.
    const request = this.request<SemanticRerankerDiagnostics>(
      'inference.rerankerDiagnostics',
      { target },
    ).then((diagnostics) => {
      this.rerankerDiagnosticCache.set(key, { diagnostics, updatedAt: Date.now() });
      return diagnostics;
    }).finally(() => {
      if (this.rerankerDiagnosticInflight.get(key) === request) {
        this.rerankerDiagnosticInflight.delete(key);
      }
    });
    this.rerankerDiagnosticInflight.set(key, request);
    return request;
  }

  upsert(
    records: VectorRecord[],
    namespace?: string,
    writeTarget?: VectorWriteTarget,
  ): Promise<number> {
    if (!namespace) return Promise.reject(new Error('Semantic vector upsert requires a namespace'));
    return this.request('vectors.upsert', {
      records,
      namespace,
      ...(writeTarget ? { writeTarget } : {}),
    });
  }

  search(
    queryVector: number[],
    options?: VectorSearchOptions,
  ): Promise<VectorMatch[]> {
    if (!options?.namespace) return Promise.resolve([]);
    return this.request('vectors.search', { queryVector, options });
  }

  deleteByIds(
    ids: string[],
    namespace?: string,
    writeTarget?: VectorWriteTarget,
  ): Promise<number> {
    if (!namespace) return Promise.reject(new Error('Semantic vector delete requires a namespace'));
    return this.request('vectors.deleteByIds', {
      ids,
      namespace,
      ...(writeTarget ? { writeTarget } : {}),
    });
  }

  listItems(
    namespace: string,
    itemKeys?: string[],
    writeTarget?: VectorWriteTarget,
  ): Promise<VectorItemState[]> {
    return this.request('vectors.listItems', {
      namespace,
      itemKeys,
      ...(writeTarget ? { writeTarget } : {}),
    });
  }

  deleteByItemKeys(itemKeys: string[], namespace: string): Promise<number> {
    return this.request('vectors.deleteByItemKeys', { itemKeys, namespace });
  }

  deleteNamespace(namespace: string): Promise<number> {
    return this.request('vectors.deleteNamespace', { namespace });
  }

  async isAvailable(): Promise<boolean> {
    try {
      return await this.request<boolean>('vectors.available', {});
    } catch {
      return false;
    }
  }

  removeProject(projectId: number): Promise<void> {
    return this.request('vectors.removeProject', { projectId });
  }

  /** Drop one obsolete generation table inside the worker-owned SQLite. */
  dropGeneration(namespace: string, generationId: number): Promise<void> {
    return this.request('vectors.dropGeneration', { namespace, generationId });
  }

  dropLegacyKnowledgeTables(namespace: string): Promise<number> {
    return this.request('vectors.dropLegacyKnowledgeTables', { namespace });
  }

  hasGeneration(namespace: string, generationId: number): Promise<boolean> {
    return this.request('vectors.hasGeneration', { namespace, generationId });
  }

  compactGenerationDatabase(
    namespace: string,
    generationId: number,
  ): Promise<{ before_bytes: number; after_bytes: number }> {
    return this.request('vectors.compactGenerationDatabase', { namespace, generationId });
  }

  /** Read the physical ids from one generation table for activation proof. */
  listIds(namespace: string, generationId: number): Promise<string[]> {
    return this.request('vectors.listIds', { namespace, generationId });
  }

  /** Reconcile one construction table without touching the active generation. */
  deleteByIdsForGeneration(
    namespace: string,
    generationId: number,
    ids: string[],
  ): Promise<number> {
    return this.request('vectors.deleteByIdsForGeneration', { namespace, generationId, ids });
  }

  /** Reconcile semantic item identities in one construction table only. */
  deleteByItemKeysForGeneration(
    namespace: string,
    generationId: number,
    itemKeys: string[],
  ): Promise<number> {
    return this.request('vectors.deleteByItemKeysForGeneration', {
      namespace,
      generationId,
      itemKeys,
    });
  }

  async dispose(): Promise<void> {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    const host = this.host;
    this.host = null;
    if (host) await host.evict();
    if (this.evicting) await this.evicting;
    this.rerankerDiagnosticCache.clear();
    this.rerankerDiagnosticInflight.clear();
  }

  private async request<T>(type: string, payload: unknown, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    const host = await this.ensureHost();
    signal?.throwIfAborted();
    const bridge = host.requireBridge();
    const inferenceRequestId = type.startsWith('inference.') ? randomUUID() : undefined;
    const cancel = () => {
      try {
        if (inferenceRequestId) bridge.emit('inference.cancel', { inferenceRequestId });
      } catch { /* A closed worker already cancelled its queue. */ }
    };
    let onAbort: (() => void) | undefined;
    this.inflight++;
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    try {
      const request = bridge.request(type, inferenceRequestId
        ? { ...(payload as object), inferenceRequestId } : payload, {
        timeoutMs: REQUEST_TIMEOUT_MS,
      });
      const aborted = signal ? new Promise<never>((_resolve, reject) => {
        onAbort = () => { cancel(); reject(signal.reason ?? new Error('Inference aborted')); };
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) onAbort();
      }) : null;
      return await (aborted ? Promise.race([request, aborted]) : request) as T;
    } catch (error) {
      if ((error as { code?: string }).code === 'request_timeout') cancel();
      throw error;
    } finally {
      if (onAbort) signal?.removeEventListener('abort', onAbort);
      this.inflight--;
      this.scheduleIdleEviction();
    }
  }

  private async ensureHost(): Promise<WorkerHost> {
    if (this.evicting) await this.evicting;
    if (this.host?.state === 'crashed') this.host = null;
    if (!this.host) {
      this.host = new WorkerHost({
        name: 'semantic-vectors',
        workerFile: this.resolved.file,
        execArgv: this.resolved.execArgv,
        workerData: { dbPath: this.dbPath, tsEntry: this.resolved.devTsEntry },
        maxRestarts: 2,
        defaultRequestTimeoutMs: REQUEST_TIMEOUT_MS,
        onCrash: (error) => console.error(`[semantic-vector-worker] crashed: ${error.message}`),
      });
    }
    await this.host.start();
    return this.host;
  }

  private scheduleIdleEviction(): void {
    if (this.inflight > 0) return;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      void this.evictHostIfIdle();
    }, DEFAULT_IDLE_MS);
    this.idleTimer.unref?.();
  }

  private async evictHostIfIdle(): Promise<void> {
    const host = this.host;
    if (this.inflight > 0 || !host?.isRunning()) return;

    try {
      // A request may have timed out in the client while native ONNX or an
      // async SQLite queue is still running in the worker. Confirm worker-side
      // idleness before releasing its sessions/handles.
      const state = await host.requireBridge().request(
        'worker.idleState',
        {},
        { timeoutMs: IDLE_PROBE_TIMEOUT_MS },
      ) as SemanticWorkerIdleState;
      if (this.inflight > 0 || this.host !== host) return;
      if (state.activeOperations > 0 || state.active || state.queued > 0) {
        this.scheduleIdleEviction();
        return;
      }
    } catch {
      // A non-responsive worker may still be blocked in native inference.
      // Recheck after another idle window instead of disposing it mid-call.
      if (this.host === host && this.inflight === 0) this.scheduleIdleEviction();
      return;
    }

    // Clear the reference before eviction so a concurrent new request creates
    // a fresh host instead of racing the stopping bridge.
    if (this.host === host) this.host = null;
    const eviction = host.evict().catch(() => undefined).finally(() => {
      if (this.evicting === eviction) this.evicting = null;
    });
    this.evicting = eviction;
  }
}
