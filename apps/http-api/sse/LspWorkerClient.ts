/**
 * Main-thread client for the lsp worker — implements LspBackendExecutor
 * over a lazy, idle-evicting WorkerHost (molde: IndexerWorkerClient).
 *
 * Doc-sync forwarding: subscribes the main document-store and mirrors
 * open/change/close to the worker while it runs. Evicted/respawned worker
 * gets a full replay of every open doc on the next bridge re-bind, and a
 * per-request docVersion check + one resync-retry covers the races the
 * replay can't (event dropped mid-flight).
 */
// Deep imports on purpose: the api-handlers barrel pulls every namespace
// (plugins, coder, …) — heavy at boot and untestable without sqlite.
import { WorkerHost, type MessageBridge } from '@mcp/orchestrator-host';
import {
  allDocs,
  getDoc,
  onDocEvent,
} from '@mcp/api-handlers/lsp/document-store.js';
import {
  isStaleSentinel,
  type DocChangeEvent,
  type DocOpenEvent,
  type LspBackendExecutor,
  type LspExecutorOp,
  type LspOpCtx,
} from '@mcp/api-handlers/lsp/executor-types.js';
import type { resolveWorkerFile } from './workerFileResolution.js';

export interface LspWorkerClientOpts {
  dbPath: string;
  /** Evict after this long with no compute in flight. Default 10min —
   *  respawn pays a TS Program rebuild, so keep it warmer than the indexer. */
  idleTtlMs?: number;
}

/** Per-op request timeouts (ms). Timeout policy lives in lsp-executor.ts. */
const OP_TIMEOUTS: Record<LspExecutorOp, number> = {
  tsCompletions: 8_000,
  tsHover: 8_000,
  tsDefinition: 10_000,
  tsReferences: 10_000,
  tsDiagnostics: 20_000,
  tsSemanticTokens: 10_000,
  fallbackCompletion: 5_000,
  fallbackDefinition: 5_000,
  fallbackHover: 5_000,
  fallbackReferences: 5_000,
};

const CRASH_COOLDOWN_MS = 60_000;

export class LspWorkerClient implements LspBackendExecutor {
  private host: WorkerHost | null = null;
  private boundBridge: MessageBridge | null = null;
  private inflight = 0;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private lastCrashAt = 0;
  private readonly unsubscribeDocs: () => void;

  constructor(
    private opts: LspWorkerClientOpts,
    private resolved: NonNullable<ReturnType<typeof resolveWorkerFile>>,
  ) {
    // Mirror doc lifecycle while the worker runs. A down worker just drops
    // events — the replay on re-bind reconstructs the full state.
    this.unsubscribeDocs = onDocEvent((e) => {
      const bridge = this.host?.isRunning() ? this.host.requireBridge() : null;
      if (!bridge) return;
      try {
        if (e.kind === 'open') {
          bridge.emit('doc.open', {
            projectId: e.projectId, file: e.file,
            languageId: e.doc.languageId, version: e.doc.version, content: e.doc.content,
          } satisfies DocOpenEvent);
        } else if (e.kind === 'change') {
          bridge.emit('doc.change', {
            projectId: e.projectId, file: e.file,
            version: e.doc.version, changes: e.changes ?? [],
          } satisfies DocChangeEvent);
        } else {
          bridge.emit('doc.close', { projectId: e.projectId, file: e.file });
        }
      } catch { /* worker going down — next ensureHost replays */ }
    });
  }

  // Property style: the interface-indexed type contextually drives call<T>.
  tsCompletions: LspBackendExecutor['tsCompletions'] = (ctx) => this.call('tsCompletions', ctx);
  tsHover: LspBackendExecutor['tsHover'] = (ctx) => this.call('tsHover', ctx);
  tsDefinition: LspBackendExecutor['tsDefinition'] = (ctx) => this.call('tsDefinition', ctx);
  tsReferences: LspBackendExecutor['tsReferences'] = (ctx) => this.call('tsReferences', ctx);
  tsDiagnostics: LspBackendExecutor['tsDiagnostics'] = (ctx) => this.call('tsDiagnostics', ctx);
  tsSemanticTokens: LspBackendExecutor['tsSemanticTokens'] = (ctx) => this.call('tsSemanticTokens', ctx);
  fallbackCompletion: LspBackendExecutor['fallbackCompletion'] = (ctx) => this.call('fallbackCompletion', ctx);
  fallbackDefinition: LspBackendExecutor['fallbackDefinition'] = (ctx) => this.call('fallbackDefinition', ctx);
  fallbackHover: LspBackendExecutor['fallbackHover'] = (ctx) => this.call('fallbackHover', ctx);
  fallbackReferences: LspBackendExecutor['fallbackReferences'] = (ctx) => this.call('fallbackReferences', ctx);

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
    this.unsubscribeDocs();
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    const host = this.host;
    this.host = null;
    if (host) await host.evict();
  }

  // ─── Internals ────────────────────────────────────────────────────

  private async call<T>(op: LspExecutorOp, ctx: LspOpCtx): Promise<T> {
    const host = await this.ensureHost();
    this.inflight++;
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
    try {
      const timeoutMs = OP_TIMEOUTS[op];
      let result = await host.requireBridge().request('lsp.call', { op, ctx }, { timeoutMs });
      if (isStaleSentinel(result)) {
        // Mirror lagged (events lost across evict/respawn): resync this doc
        // and retry once. A second stale answer means something is wrong —
        // surface as an error so the wrapper falls back in-process.
        this.resyncDoc(host, ctx.projectId, ctx.file);
        result = await host.requireBridge().request('lsp.call', { op, ctx }, { timeoutMs });
        if (isStaleSentinel(result)) throw new Error(`lsp-worker mirror stale for ${ctx.file} after resync`);
      }
      return result as T;
    } finally {
      this.inflight--;
      this.scheduleIdleEvict();
    }
  }

  private resyncDoc(host: WorkerHost, projectId: number, file: string): void {
    const doc = getDoc(projectId, file);
    if (!doc) return; // closed meanwhile — retry will answer stale → fallback
    host.requireBridge().emit('doc.open', {
      projectId, file, languageId: doc.languageId, version: doc.version, content: doc.content,
    } satisfies DocOpenEvent);
  }

  private async ensureHost(): Promise<WorkerHost> {
    if (this.host && this.host.state === 'crashed') {
      this.host = null;
      this.lastCrashAt = Date.now();
    }
    // Cooldown after a crash: don't thrash respawns on a poisoned project —
    // callers fall back in-process for a minute (same as pre-worker).
    if (!this.host && this.lastCrashAt && Date.now() - this.lastCrashAt < CRASH_COOLDOWN_MS) {
      throw new Error('lsp-worker cooling down after crash');
    }
    if (!this.host) {
      this.host = new WorkerHost({
        name: 'lsp',
        workerFile: this.resolved.file,
        execArgv: this.resolved.execArgv,
        workerData: {
          dbPath: this.opts.dbPath,
          tsEntry: this.resolved.devTsEntry,
        },
        maxRestarts: 2,
        defaultRequestTimeoutMs: 20_000,
        onCrash: (err) => {
          this.lastCrashAt = Date.now();
          console.error(`[lsp-worker] crashed: ${err.message}`);
        },
      });
    }
    await this.host.start();
    const bridge = this.host.requireBridge();
    if (bridge !== this.boundBridge) {
      // New bridge = fresh worker with an EMPTY mirror: replay every open
      // doc so unsaved buffers answer correctly, and rewire resync requests.
      bridge.on('doc.resyncNeeded', (data) => {
        const { projectId, file } = data as { projectId: number; file: string };
        if (this.host?.isRunning()) this.resyncDoc(this.host, projectId, file);
      });
      for (const { projectId, file, doc } of allDocs()) {
        bridge.emit('doc.open', {
          projectId, file, languageId: doc.languageId, version: doc.version, content: doc.content,
        } satisfies DocOpenEvent);
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
    }, this.opts.idleTtlMs ?? 600_000);
    this.idleTimer.unref?.();
  }
}
