/**
 * Main-thread client for the indexer worker — implements StructuralExecutor
 * over a lazy, idle-evicting WorkerHost. Keeps all structural execution off the Electron main thread.
 */
import { WorkerHost, type MessageBridge } from '@mcp/orchestrator-host';
import type {
  DirtyEvent,
  IndexFilesSummary,
  StructuralChangeHandler,
  StructuralExecutor,
  StructuralProgressFrame,
  StructuralRunSummary,
} from '@mcp/services/services/project-index/index.js';
import { resolveWorkerFile } from './workerFileResolution.js';

interface IndexerWorkerClientOpts {
  dbPath: string;
  ignorePatterns?: string[];
  maxFileSizeKB?: number;
  concurrency?: number;
  /** Evict the worker after this long with no in-flight work. Default 2min. */
  idleTtlMs?: number;
  /** CLI-only escape hatch; desktop must keep structural work off main. */
  allowInProcessFallback?: boolean;
}

const RUN_TIMEOUT_MS = 10 * 60_000;   // big repos — the run streams progress anyway
const FILES_TIMEOUT_MS = 120_000;

export class IndexerWorkerClient implements StructuralExecutor {
  private host: WorkerHost | null = null;
  private boundBridge: MessageBridge | null = null;
  private inflight = 0;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private interactivePriorityProjects = new Set<number>();
  private progressHandlers = new Map<number, (p: StructuralProgressFrame) => void>();
  private changeHandlers = new Map<
    number,
    StructuralChangeHandler
  >();

  constructor(
    private opts: IndexerWorkerClientOpts,
    private resolved: NonNullable<ReturnType<typeof resolveWorkerFile>>,
  ) {}

  setInteractivePriority(projectId: number, busy: boolean): void {
    if (busy) this.interactivePriorityProjects.add(projectId);
    else this.interactivePriorityProjects.delete(projectId);
    if (this.host?.state === 'running') {
      this.host.requireBridge().emit('interactivePriority', { projectId, busy });
    }
  }

  async runStructuralIndex(
    projectId: number,
    opts: {
      maxFiles?: number;
      allowEmptyWipe?: boolean;
      forceReparse?: boolean;
      verifyPaths?: string[];
      onProgress?: (p: StructuralProgressFrame) => void;
      onChanges?: StructuralChangeHandler;
    },
  ): Promise<StructuralRunSummary> {
    if (opts.onProgress) this.progressHandlers.set(projectId, opts.onProgress);
    if (opts.onChanges) this.changeHandlers.set(projectId, opts.onChanges);
    try {
      return await this.request<StructuralRunSummary>(
        'structuralIndex',
        {
          projectId,
          maxFiles: opts.maxFiles,
          allowEmptyWipe: opts.allowEmptyWipe,
          forceReparse: opts.forceReparse,
          verifyPaths: opts.verifyPaths,
          reportChanges: Boolean(opts.onChanges),
        },
        RUN_TIMEOUT_MS,
      );
    } finally {
      this.progressHandlers.delete(projectId);
      this.changeHandlers.delete(projectId);
    }
  }

  async indexFiles(
    projectId: number,
    relPaths: string[],
    opts?: { onChanges?: StructuralChangeHandler },
  ): Promise<IndexFilesSummary> {
    if (opts?.onChanges) this.changeHandlers.set(projectId, opts.onChanges);
    try {
      return await this.request<IndexFilesSummary>(
        'indexFiles',
        { projectId, relPaths, reportChanges: Boolean(opts?.onChanges) },
        FILES_TIMEOUT_MS,
      );
    } finally {
      if (opts?.onChanges) this.changeHandlers.delete(projectId);
    }
  }

  async removeFiles(
    projectId: number,
    relPaths: string[],
    opts?: { onChanges?: StructuralChangeHandler },
  ): Promise<{ removed: number }> {
    if (opts?.onChanges) this.changeHandlers.set(projectId, opts.onChanges);
    try {
      return await this.request<{ removed: number }>(
        'removeFiles',
        { projectId, relPaths, reportChanges: Boolean(opts?.onChanges) },
        FILES_TIMEOUT_MS,
      );
    } finally {
      if (opts?.onChanges) this.changeHandlers.delete(projectId);
    }
  }

  /**
   * Per-isolate heap stats for the admin perf monitor. Returns null when
   * the worker isn't currently spawned — we never spawn just to measure.
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
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
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
    } catch (error) {
      if ((error as { code?: string }).code === 'request_timeout') {
        // A timed-out worker can still be writing. Stop it before allowing a retry.
        await host.evict();
        if (this.host === host) this.host = null;
      }
      throw error;
    } finally {
      this.inflight--;
      this.scheduleIdleEvict();
    }
  }

  private async ensureHost(): Promise<WorkerHost> {
    // A crashed host (restart budget exhausted) is replaced by a fresh one
    // on the next call — the structural run is hash-idempotent, so a retry
    // after crash just resumes where the data left off.
    if (this.host && this.host.state === 'crashed') this.host = null;
    if (!this.host) {
      this.host = new WorkerHost({
        name: 'indexer',
        workerFile: this.resolved.file,
        execArgv: this.resolved.execArgv,
        workerData: {
          dbPath: this.opts.dbPath,
          ignorePatterns: this.opts.ignorePatterns,
          maxFileSizeKB: this.opts.maxFileSizeKB,
          concurrency: this.opts.concurrency,
          // Dev bootstrap reads this to dynamic-import the TS entry after
          // registering tsx. Absent in production builds.
          tsEntry: this.resolved.devTsEntry,
        },
        maxRestarts: 2,
        defaultRequestTimeoutMs: FILES_TIMEOUT_MS,
        onCrash: (err) => console.error(`[indexer-worker] crashed: ${err.message}`),
      });
    }
    await this.host.start();
    // (Re)bind the progress listener — every restart/evict cycle creates a
    // NEW bridge, and a subscription on the old one is silently dead.
    const bridge = this.host.requireBridge();
    if (bridge !== this.boundBridge) {
      bridge.on('structural.progress', (data) => {
        const p = data as StructuralProgressFrame & { projectId: number };
        this.progressHandlers.get(p.projectId)?.(p);
      });
      bridge.handle('structural.changes', async (data) => {
        const payload = data as {
          projectId: number;
          events: DirtyEvent[];
          previousItemKeys?: string[];
        };
        const handler = this.changeHandlers.get(payload.projectId);
        if (!handler) {
          throw new Error(
            `no structural change handler registered for project ${payload.projectId}`,
          );
        }
        await handler(payload.events, payload.previousItemKeys ?? []);
        return { ok: true };
      });
      for (const projectId of this.interactivePriorityProjects) {
        bridge.emit('interactivePriority', { projectId, busy: true });
      }
      this.boundBridge = bridge;
    }
    return this.host;
  }

  private scheduleIdleEvict(): void {
    if (this.inflight > 0) return;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (this.inflight === 0 && this.host?.isRunning()) {
        void this.host.evict().catch(() => undefined);
      }
    }, this.opts.idleTtlMs ?? 120_000);
    this.idleTimer.unref?.();
  }
}

/**
 * Observable signal for the structural worker → in-process fallback. When the
 * worker can't run (packaging gap, repeated crash) the pipeline runs on the
 * Electron MAIN thread, which is the worst case for large-project freezes. A
 * module-level counter (readable by the admin perf surface) + a prominent log
 * make "is this happening in production?" answerable instead of a silent warn.
 */
const indexerFallbackStats = {
  count: 0,
  lastOp: '',
  lastError: '',
  lastAt: 0,
};

/**
 * Build the worker executor. Only standalone CLI hosts may use an in-process
 * executor when the worker entry is unavailable.
 */
export function createStructuralIndexerExecutor(
  opts: IndexerWorkerClientOpts,
  fallback: StructuralExecutor,
): { executor: StructuralExecutor; client: IndexerWorkerClient | null } {
  const allowFallback = opts.allowInProcessFallback ?? !process.versions.electron;
  const resolved = process.env.MCP_INDEX_STRUCTURAL_WORKER === '0'
    ? null : resolveWorkerFile(import.meta.url, 'indexer-worker');
  if (!resolved) {
    if (allowFallback) return { executor: fallback, client: null };
    const unavailable = async (): Promise<never> => {
      throw new Error('Structural indexing worker unavailable; rebuild the worker bundle and enable MCP_INDEX_STRUCTURAL_WORKER');
    };
    return { executor: {
      runStructuralIndex: unavailable, indexFiles: unavailable, removeFiles: unavailable,
    }, client: null };
  }
  const client = new IndexerWorkerClient(opts, resolved);
  // Once submitted, a worker operation may already have committed writes.
  // Surface errors; never start a second copy on the UI thread.
  return { executor: client, client };
}
