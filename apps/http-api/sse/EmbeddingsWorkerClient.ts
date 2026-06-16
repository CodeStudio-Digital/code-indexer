/**
 * Main-thread client for the embeddings worker — implements EmbeddingService
 * over a lazy, idle-evicting WorkerHost so the CPU-bound local ONNX inference
 * runs off the main thread (which, in Electron, IS the whole backend).
 * Composes with the in-process LocalEmbeddingService as a fallback, so the
 * feature NEVER depends on the worker build existing (dev without bootstrap,
 * packaging gaps, repeated crashes).
 *
 * Only meaningful for the LOCAL backend: cloudflare/bedrock `embed()` is async
 * network I/O that never blocks the event loop, so the factory below short-
 * circuits to the in-process service for them.
 */
import { WorkerHost } from '@mcp/orchestrator-host';
import type { EmbeddingService } from '@mcp/indexer/search/embeddings.js';
import { resolveWorkerFile, type ResolvedWorker } from './workerFileResolution.js';

export interface EmbeddingsWorkerClientOpts {
  /** Model id forwarded to the worker's LocalEmbeddingService. */
  model?: string;
  /** Optional admin cache-dir override forwarded to the worker. */
  cacheDir?: string;
  /** Evict the worker after this long with no in-flight work. Default 5min. */
  idleTtlMs?: number;
  /** Authoritative `local:<model>` fingerprint the in-process service reports. */
  fingerprint: string;
}

const EMBED_TIMEOUT_MS = 120_000;
const QUERY_TIMEOUT_MS = 30_000;
const DEFAULT_IDLE_MS = 5 * 60_000;

export class EmbeddingsWorkerClient implements EmbeddingService {
  private host: WorkerHost | null = null;
  private inflight = 0;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private opts: EmbeddingsWorkerClientOpts,
    private resolved: ResolvedWorker,
  ) {}

  async embed(texts: string[]): Promise<{ vectors: number[][]; tokens: number }> {
    if (texts.length === 0) return { vectors: [], tokens: 0 };
    return this.request('embed', { texts }, EMBED_TIMEOUT_MS);
  }

  async embedQuery(text: string): Promise<{ vector: number[]; tokens: number }> {
    return this.request('embedQuery', { text }, QUERY_TIMEOUT_MS);
  }

  /** Sync + local — the indexer reads this to detect a model change. */
  fingerprint(): string {
    return this.opts.fingerprint;
  }

  /** One ONNX session in one isolate — keep the batch runner serial. */
  maxConcurrency(): number {
    return 1;
  }

  /**
   * Sync ledger probe (perf monitor). `loaded` proxies "worker isolate is
   * alive" — when it's been idle-evicted the native ONNX RSS is fully gone.
   * Never spawns the worker just to measure.
   */
  diagnostics(): { model: string; loaded: boolean } {
    return { model: this.opts.fingerprint.replace(/^local:/, ''), loaded: this.host?.isRunning() === true };
  }

  /**
   * Per-isolate heap stats for the admin perf monitor. Null when the worker
   * isn't spawned — we never spawn just to measure.
   */
  async memStats(
    timeoutMs = 2_000,
  ): Promise<import('../workers/perf-stats.js').WorkerMemStats | null> {
    const host = this.host;
    if (!host || host.state !== 'running') return null;
    try {
      return (await host
        .requireBridge()
        .request('perf.memStats', {}, { timeoutMs })) as import('../workers/perf-stats.js').WorkerMemStats;
    } catch {
      return null;
    }
  }

  async dispose(): Promise<void> {
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
    const host = this.host;
    this.host = null;
    if (host) await host.evict();
  }

  // ─── Internals ────────────────────────────────────────────────────

  private async request<T>(type: string, payload: unknown, timeoutMs: number): Promise<T> {
    const host = await this.ensureHost();
    this.inflight++;
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
    try {
      return (await host.requireBridge().request(type, payload, { timeoutMs })) as T;
    } finally {
      this.inflight--;
      this.scheduleIdleEvict();
    }
  }

  private async ensureHost(): Promise<WorkerHost> {
    // A crashed host (restart budget exhausted) is replaced by a fresh one on
    // the next call — embedding is pure/idempotent, so a retry just re-runs.
    if (this.host && this.host.state === 'crashed') this.host = null;
    if (!this.host) {
      this.host = new WorkerHost({
        name: 'embeddings',
        workerFile: this.resolved.file,
        execArgv: this.resolved.execArgv,
        workerData: {
          model: this.opts.model,
          cacheDir: this.opts.cacheDir,
          // Dev bootstrap reads this to dynamic-import the TS entry after
          // registering tsx. Absent in production builds.
          tsEntry: this.resolved.devTsEntry,
        },
        maxRestarts: 2,
        defaultRequestTimeoutMs: EMBED_TIMEOUT_MS,
        onCrash: (err) => console.error(`[embeddings-worker] crashed: ${err.message}`),
      });
    }
    await this.host.start();
    return this.host;
  }

  private scheduleIdleEvict(): void {
    if (this.inflight > 0) return;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (this.inflight === 0 && this.host?.isRunning()) {
        void this.host.evict().catch(() => undefined);
      }
    }, this.opts.idleTtlMs ?? DEFAULT_IDLE_MS);
    this.idleTimer.unref?.();
  }
}

export interface EmbeddingExecutorOpts extends EmbeddingsWorkerClientOpts {
  /** Only the local ONNX backend benefits — others stay in-process. */
  isLocal: boolean;
}

/**
 * Build the embedding service: worker-backed when the backend is local, the
 * kill switch is off, and the worker file resolves; otherwise the given
 * in-process service. `embed`/`embedQuery` fall back per-call to in-process on
 * worker errors (mirrors createIndexerExecutor); `fingerprint`/`maxConcurrency`
 * /`diagnostics` are synchronous and delegate straight to the client.
 */
export function createEmbeddingExecutor(
  opts: EmbeddingExecutorOpts,
  fallback: EmbeddingService,
): { executor: EmbeddingService; client: EmbeddingsWorkerClient | null } {
  if (!opts.isLocal || process.env.MCP_EMBED_WORKER === '0') {
    return { executor: fallback, client: null };
  }
  const resolved = resolveWorkerFile(import.meta.url, 'embeddings-worker');
  if (!resolved) {
    console.warn('[embeddings-worker] worker entry not found — embeddings run in-process');
    return { executor: fallback, client: null };
  }
  const client = new EmbeddingsWorkerClient(opts, resolved);
  const withFallback = <A extends unknown[], R>(
    name: string,
    workerFn: (...args: A) => Promise<R>,
    fallbackFn: (...args: A) => Promise<R>,
  ) => async (...args: A): Promise<R> => {
    try {
      return await workerFn(...args);
    } catch (err) {
      console.warn(`[embeddings-worker] ${name} failed (${err instanceof Error ? err.message : err}) — falling back in-process`);
      return fallbackFn(...args);
    }
  };
  const executor: EmbeddingService & { diagnostics(): { model: string; loaded: boolean } } = {
    embed: withFallback('embed', client.embed.bind(client), fallback.embed.bind(fallback)),
    embedQuery: withFallback('embedQuery', client.embedQuery.bind(client), fallback.embedQuery.bind(fallback)),
    fingerprint: () => client.fingerprint(),
    maxConcurrency: () => client.maxConcurrency(),
    diagnostics: () => client.diagnostics(),
    dispose: () => client.dispose(),
  };
  return { executor, client };
}
