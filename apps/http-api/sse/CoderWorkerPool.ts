/**
 * Pool of worker-backed coder runs (P17).
 *
 * Mirrors `WorkerOrchestratorPool` for the simpler coder path. Each
 * active `coder_sessions.id` maps to a `WorkerHost` running
 * `apps/http-api/workers/coder-worker.ts`. The worker hosts the
 * actual `runCoder()` call and its runner; main holds a mirrored
 * `CoderRunBus` populated by worker events.
 *
 * Public surface:
 *
 *   - `getBus(id)` — returns the mirrored bus for an already-spawned
 *     session, or `null`. Compatible with `activeRuns.get(id)` reads
 *     in `coder/stream.ts` etc.
 *   - `runFresh(id, opts)` — spawns a worker (if needed) and starts
 *     a brand-new `runCoder()` invocation inside it.
 *   - `sendUserMessage(id, content)` — pushes a follow-up message to
 *     the worker's runner. Handles the is-waiting / interject
 *     decision tree on the worker side via a single RPC.
 *   - `isWaitingForInput(id)` — proxy read of the runner's waiting
 *     flag, used by the legacy decision tree on main.
 *   - `interruptWait(id)`, `abort(id)` — runner control proxies.
 *
 * The pool reuses the same `OrchestratorRegistry`-style fallback
 * pattern: routes call `runtime.activeRuns.get(id)`, the pool injects
 * itself transparently when the env flag `MCP_CODER_WORKER=1` is on.
 */
import { WorkerHost } from '@mcp/orchestrator-host';
import {
  createBus,
  publish,
  markEnded,
  emitWorkerLog,
  type CoderRunBus,
} from '../coder-bus.js';
import type { CoderAttachment } from '@mcp/code-agent/index.js';
import type { DocSearchBackend } from '@mcp/code-agent/tools/rag-search-docs.js';
import { getGlobalPreviewDevtools, type PreviewInvoke } from '@mcp/code-agent/tools/preview/index.js';
import type { IVisionDescriber, VisionDescribeRequest } from '@mcp/code-agent/core/vision-describer.js';
import type { DocsResearchBridge } from '@mcp/docs-agent/bridges/docs-bridge.js';
import type { McpExternalPool } from './McpExternalPool.js';
import { installRuntimeEventLog } from './runtime-event-log.js';

/**
 * Optional doc-corpus deps the host wires AFTER `boot/createApp` has built
 * `DocHybridSearch` + `DocsResearchBridge`. The pool holds them in a mutable
 * box because the main-process server.ts can't construct them before
 * `getCoderWorkerPool` runs (the singleton resolves lazily on the first
 * runFresh request, by which point the deps are ready).
 *
 * When set, each `ensureEntry()` call wires bridge handlers that route
 * `rag_search_docs` / `docs_deep_research` from the worker process BACK
 * to these main-thread singletons via MessageBridge RPC. Worker-side
 * shims live in `apps/http-api/workers/coder-worker.ts`.
 *
 * Both fields stay nullable so headless tests / detached runners can
 * spawn the pool without docs support — the worker shim degrades to
 * the same "not configured" message the in-process path already used to
 * emit when `setGlobalDocSearch(null)` was active.
 */
export interface CoderWorkerDocDeps {
  docSearch?: DocSearchBackend | null;
  docsResearch?: DocsResearchBridge | null;
  /** Main-side vision describer; worker reaches it via `visionDescribe` RPC. */
  vision?: IVisionDescriber | null;
}

export interface CoderWorkerPoolOpts {
  /** Absolute path Node spawns — built `.js` in prod, dev bootstrap `.mjs` in dev. */
  workerFile: string;
  /** Extra execArgv (reserved). */
  workerExecArgv?: string[];
  /** Dev-mode TS entry the bootstrap dynamic-imports. */
  workerDevTsEntry?: string;
  /** SQLite path passed to each worker. */
  dbPath: string;
  /** Idle TTL before eviction. Default 5 min — only used between runs. */
  ttlMs?: number;
  /**
   * Linger window after a run finishes (bus emits `done`/`error`). The
   * pool waits this long for a follow-up turn before evicting the
   * worker. Mirrors the legacy in-process `BUS_LINGER_MS` so a fast
   * `/messages` POST right after `done` still reuses the same worker
   * (no cold-start cost). Default 30 s.
   */
  postRunLingerMs?: number;
  /** Logger. */
  log?: (level: 'info' | 'warn' | 'error', msg: string) => void;
  /**
   * Mutable doc-deps box. Mutated by the singleton wire-up
   * (`setCoderWorkerDocDeps` in `coderWorkerPoolSingleton.ts`); the pool
   * reads each field at ensureEntry-time so a deps update propagates
   * to the NEXT worker spawned.
   */
  docDeps?: CoderWorkerDocDeps;
  /**
   * Optional getter for the shared external-MCP pool. We use a getter
   * (instead of a direct reference) so server.ts can spawn the pool
   * asynchronously AFTER the dashboard starts serving requests, and
   * the very first worker spawned still picks up the pool once it's
   * ready. Returning `null` keeps the legacy per-worker
   * `McpServerManager` path alive (covers boot-race + tests).
   */
  getMcpExternalPool?: () => McpExternalPool | null;
}

interface PoolEntry {
  host: WorkerHost;
  bus: CoderRunBus;
  currentRunId: number;
  lastTouchedAt: number;
  detachCurrentBusRuntimeLog: () => void;
  detachBusMirror: () => void;
  /**
   * Scheduled fast-eviction handle, set when `bus.end` arrives. Cleared
   * on the next `runFresh` / `pushUserMessage` so a re-engaged session
   * doesn't get evicted out from under the user.
   */
  postRunEvictTimer: ReturnType<typeof setTimeout> | null;
  /**
   * True while a `runCoder()` is in flight (between `runFresh` /
   * `pushUserMessage` and the next `bus.end`). The idle sweep MUST NOT
   * evict entries with `runInProgress=true` — a slow provider (6+ min
   * on a fat prompt; session 798 symptom) makes the worker look idle
   * to the sweep even though it is actively doing real work.
   *
   * Separate from `bus.ended` because the bus object is swapped between
   * sequential runs while the worker stays warm.
   */
  runInProgress: boolean;
}

export interface RunFreshOpts {
  userMessage: string;
  attachments?: CoderAttachment[];
  maxTurns?: number;
  planMode?: boolean;
  agent?: 'explore' | 'plan' | 'build' | 'admin' | 'spec';
  profile?: 'bootstrap' | 'navigate' | 'full' | 'auto';
  /** POJO worktree opts — survives structuredClone across MessagePort. */
  worktree?: { name?: string; branch?: string };
  thinking?: boolean;
  /** Vision fallback — `modelSupportsVision === false` triggers auto image→text
   *  describe; `describeImages` (composer flag) forces it. Forwarded to runCoder. */
  modelSupportsVision?: boolean;
  describeImages?: boolean;
  /** Auto-activate the `preview` DevTools tier (builder/dev-server sessions). */
  previewAvailable?: boolean;
  /** Simulated deepThink (auxiliary cheap model writes a pre-thought
   *  before each main-model turn). Orthogonal to `thinking`. */
  deepThink?: boolean;
  deepThinkModel?: string;
  deepThinkProvider?: string;
  preThinkOnToolResults?: boolean;
  /** Skill IDs the user pre-selected in the sidebar; forwarded to runCoder. */
  selectedSkillIds?: string[];
  /**
   * When true, the worker calls `runCoder({ resume: true })` so the runner
   * picks up from history (last DB message must be `role:'tool'`) instead
   * of pushing a brand-new user turn. Used by the Apêndice 4 Fase 2
   * interaction fallback when a previous worker died mid-wait — the
   * dashboard POSTs `/messages` with `{ resume: true, content: '' }` to
   * spawn a fresh worker that resumes from the tool_result just appended.
   */
  resume?: boolean;
}

export class CoderWorkerPool {
  private readonly entries = new Map<number, PoolEntry>();
  private readonly ttlMs: number;
  private readonly postRunLingerMs: number;
  private readonly log: (level: 'info' | 'warn' | 'error', msg: string) => void;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private nextRunId = 1;

  constructor(private readonly opts: CoderWorkerPoolOpts) {
    this.ttlMs = opts.ttlMs ?? 5 * 60 * 1000;
    this.postRunLingerMs = opts.postRunLingerMs ?? 30_000;
    this.log = opts.log ?? ((level, msg) => console[level === 'info' ? 'log' : level](msg));
    this.sweepTimer = setInterval(() => this.sweep(), 60_000);
    if (this.sweepTimer && typeof (this.sweepTimer as { unref?: () => void }).unref === 'function') {
      (this.sweepTimer as { unref: () => void }).unref();
    }
  }

  /** Read the mirrored bus for a session. Touches `lastTouchedAt`. */
  getBus(sessionId: number): CoderRunBus | null {
    const entry = this.entries.get(sessionId);
    if (!entry) return null;
    entry.lastTouchedAt = Date.now();
    return entry.bus;
  }

  has(sessionId: number): boolean {
    return this.entries.has(sessionId);
  }

  /**
   * Snapshot for the `/api/admin/workers` diagnostic endpoint —
   * symmetric with `WorkerOrchestratorPool.snapshot()`.
   */
  snapshot(): Array<{
    sessionId: number;
    workerState: string;
    lastTouchedAt: number;
    idleMs: number;
  }> {
    const now = Date.now();
    const out: Array<{
      sessionId: number;
      workerState: string;
      lastTouchedAt: number;
      idleMs: number;
    }> = [];
    for (const [id, entry] of this.entries) {
      out.push({
        sessionId: id,
        workerState: entry.host.state,
        lastTouchedAt: entry.lastTouchedAt,
        idleMs: now - entry.lastTouchedAt,
      });
    }
    return out;
  }

  /**
   * Spawn (if needed) and kick off a fresh `runCoder()` in the worker.
   * Returns the mirrored bus the caller should pump to SSE.
   */
  async runFresh(sessionId: number, opts: RunFreshOpts): Promise<CoderRunBus> {
    const entry = await this.ensureEntry(sessionId);
    if (entry.runInProgress && !entry.bus.ended) {
      throw new Error(`coder-pool: run already in progress for session ${sessionId}`);
    }
    this.cancelPostRunEvict(entry);
    entry.lastTouchedAt = Date.now();
    const runId = this.nextRunId++;
    this.prepareRunBus(entry, sessionId, runId);
    // (B) — mark the run in-progress so the idle sweep keeps hands off
    // until the worker emits its terminal `done`/`error` via the bus
    // event mirror below.
    entry.runInProgress = true;
    const bridge = entry.host.requireBridge();
    try {
      await bridge.request('runFresh', { ...opts, runId }, { timeoutMs: 60_000 });
    } catch (err) {
      entry.runInProgress = false;
      if (!entry.bus.ended) {
        const message = err instanceof Error ? err.message : String(err);
        publish(entry.bus, 'error', { message, reason: 'worker-runFresh-failed', sessionId });
        markEnded(entry.bus, 'error', {
          message,
          reason: 'worker-runFresh-failed',
          sessionId,
        });
        this.schedulePostRunEvict(entry, sessionId);
      }
      throw err;
    }
    return entry.bus;
  }

  /** Forward a follow-up user message to the worker's runner. */
  async pushUserMessage(
    sessionId: number,
    content: string,
    selectedSkillIds?: string[],
  ): Promise<void> {
    const entry = this.entries.get(sessionId);
    if (!entry) throw new Error(`coder-pool: no active run for session ${sessionId}`);
    this.cancelPostRunEvict(entry);
    entry.lastTouchedAt = Date.now();
    // (B) — re-engaging the worker mid-linger restarts the in-flight
    // semantics. Cleared again when the next `bus.end` arrives.
    entry.runInProgress = true;
    await entry.host.requireBridge().request('pushUserMessage', { content, selectedSkillIds });
  }

  /**
   * Drop the post-run linger timer (and zero the slot so the timer
   * callback bails on re-check). Called whenever a fresh activity
   * arrives — the worker has work to do, no eviction yet.
   */
  private cancelPostRunEvict(entry: PoolEntry): void {
    if (!entry.postRunEvictTimer) return;
    clearTimeout(entry.postRunEvictTimer);
    entry.postRunEvictTimer = null;
  }

  private prepareRunBus(entry: PoolEntry, sessionId: number, runId: number): void {
    if (entry.currentRunId !== 0 || entry.bus.ended) {
      try { entry.detachCurrentBusRuntimeLog(); } catch { /* best-effort */ }
      entry.bus = createBus(new AbortController());
      entry.detachCurrentBusRuntimeLog = installRuntimeEventLog(entry.bus, 'coder', sessionId);
    }
    entry.currentRunId = runId;
  }

  private schedulePostRunEvict(entry: PoolEntry, sessionId: number): void {
    if (entry.postRunEvictTimer) clearTimeout(entry.postRunEvictTimer);
    entry.postRunEvictTimer = setTimeout(() => {
      // Re-check: a fresh run might have already cleared the timer
      // and bumped lastTouchedAt. Don't evict if so.
      const still = this.entries.get(sessionId);
      if (!still) return;
      if (still.postRunEvictTimer === null) return;
      this.log(
        'info',
        `[coder-pool] post-run linger expired — evicting session=${sessionId}`,
      );
      void this.evict(sessionId);
    }, this.postRunLingerMs);
    if (typeof (entry.postRunEvictTimer as { unref?: () => void }).unref === 'function') {
      (entry.postRunEvictTimer as { unref: () => void }).unref();
    }
  }

  async isWaitingForInput(sessionId: number): Promise<boolean> {
    const entry = this.entries.get(sessionId);
    if (!entry) return false;
    return entry.host.requireBridge().request<boolean>('isWaitingForInput', {});
  }

  /**
   * Forward a `provideUserInput` to the worker's runner — used by
   * `/answer`, `/plan-response`, `/tasks-response` when worker mode is
   * on. Returns true when the runner was actually waiting; false means
   * the caller should fall back to the resume path (synthesize the
   * tool_result and append to message history).
   */
  async provideUserInput(sessionId: number, value: string, askId?: string): Promise<boolean> {
    const entry = this.entries.get(sessionId);
    if (!entry) return false;
    this.cancelPostRunEvict(entry);
    entry.lastTouchedAt = Date.now();
    const result = await entry.host
      .requireBridge()
      .request<{ ok: boolean }>('provideUserInput', { value, askId });
    return !!result?.ok;
  }

  async interruptWait(sessionId: number): Promise<void> {
    const entry = this.entries.get(sessionId);
    if (!entry) return;
    await entry.host.requireBridge().request('interruptWait', {});
  }

  async setThinking(sessionId: number, thinking: boolean): Promise<void> {
    const entry = this.entries.get(sessionId);
    if (!entry) return;
    await entry.host.requireBridge().request('setThinking', { thinking });
  }

  /** Push a mid-run tool-permission-mode change into the live runner. */
  async setToolPermissionMode(sessionId: number, mode: 'ask' | 'auto' | 'unrestricted'): Promise<void> {
    const entry = this.entries.get(sessionId);
    if (!entry) return;
    await entry.host.requireBridge().request('setToolPermissionMode', { mode });
  }

  async abort(sessionId: number): Promise<void> {
    const entry = this.entries.get(sessionId);
    if (!entry) return;
    await entry.host.requireBridge().request('abort', {});
  }

  async evict(sessionId: number): Promise<void> {
    const entry = this.entries.get(sessionId);
    if (!entry) return;
    this.entries.delete(sessionId);
    this.cancelPostRunEvict(entry);
    entry.detachBusMirror();
    const aliveMs = Date.now() - entry.lastTouchedAt;
    try {
      await entry.host.evict(5_000);
      this.log('info', `[coder-pool] worker evicted session=${sessionId} (idle=${aliveMs}ms)`);
    } catch (err) {
      this.log(
        'warn',
        `[coder-pool] evict session=${sessionId} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async dispose(): Promise<void> {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    const ids = Array.from(this.entries.keys());
    await Promise.all(ids.map((id) => this.evict(id)));
  }

  private sweep(): void {
    const now = Date.now();
    for (const [id, entry] of this.entries) {
      // (B) — never evict while a run is in flight. A slow provider or
      // long subagent batch can keep the worker busy past ttlMs without
      // any external HTTP touch (the dashboard streams but doesn't
      // re-POST). `runInProgress` is flipped by the `bus.event`
      // mirror via the worker's own activity, so a hung run still
      // gets evicted eventually by the server-side watchdog
      // (Frente E) — but the normal sweep here stays hands-off.
      if (entry.runInProgress) continue;
      if (now - entry.lastTouchedAt > this.ttlMs) {
        void this.evict(id);
      }
    }
  }

  private async ensureEntry(sessionId: number): Promise<PoolEntry> {
    const existing = this.entries.get(sessionId);
    if (existing) return existing;

    const host = new WorkerHost({
      name: `coder-session-${sessionId}`,
      workerFile: this.opts.workerFile,
      workerData: {
        sessionId,
        dbPath: this.opts.dbPath,
        // Dev bootstrap reads this to dynamic-import the real TS entry
        // after registering tsx. Absent in production builds.
        tsEntry: this.opts.workerDevTsEntry,
      },
      execArgv: this.opts.workerExecArgv,
      maxRestarts: 3,
      defaultRequestTimeoutMs: 120_000,
      onCrash: (err) => {
        this.log('error', `[coder-pool] worker session=${sessionId} crashed: ${err.message}`);
        // Apêndice 4 Fase 1 — structured crash log so post-mortem can
        // tie the dashboard "Connecting…" hang back to a specific
        // worker exit. Behind MCP_CODER_WORKER_DEBUG=1 (cheap, but the
        // stack can be noisy in prod logs).
        if (process.env.MCP_CODER_WORKER_DEBUG === '1') {
          const entry = this.entries.get(sessionId);
          const now = Date.now();
          console.error(
            `[coder-pool] worker-crashed ${JSON.stringify({
              sessionId,
              errorName: err.name,
              message: err.message,
              stack: err.stack,
              lastTouchedAt: entry?.lastTouchedAt ?? null,
              msSinceLastTouch: entry?.lastTouchedAt ? now - entry.lastTouchedAt : null,
              busEnded: entry?.bus?.ended ?? null,
              hadEntry: !!entry,
            })}`,
          );
        }
        // Notify the SSE pump BEFORE we drop the entry — otherwise
        // `waitEnded(bus)` (in `pumpBusToSSE`) hangs forever and the
        // dashboard sits on "Conectando…" with no terminal event. The
        // worker's own `process.on('uncaughtException')` (coder-worker.ts)
        // covers the case where the run loop throws synchronously. THIS
        // path covers the harder failures: process exit from OOM, SIGKILL,
        // segfault in a native dep — anywhere the worker can't run JS
        // anymore. Belt-and-suspenders.
        const entry = this.entries.get(sessionId);
        if (entry?.bus && !entry.bus.ended) {
          // Emit a worker_log BEFORE markEnded so the dashboard's
          // WorkerLogPanel renders the crash with its real reason
          // alongside the terminal `error` event.
          emitWorkerLog(entry.bus, 'error', 'pool', 'worker crashed', {
            sessionId,
            errorName: err.name,
            message: err.message,
          });
          publish(entry.bus, 'error', {
            message: `worker crashed: ${err.message}`,
            reason: 'worker-crashed',
            sessionId,
          });
          markEnded(entry.bus, 'error', {
            reason: 'worker-crashed',
            message: err.message,
            sessionId,
          });
        }
        this.entries.delete(sessionId);
      },
      onError: (err) => {
        this.log('warn', `[coder-pool] worker session=${sessionId} error: ${err.message}`);
      },
    });
    const startedAt = Date.now();
    await host.start();
    const bootMs = Date.now() - startedAt;
    this.log(
      'info',
      `[coder-pool] worker spawned session=${sessionId} (boot=${bootMs}ms)`,
    );

    // Mirror the worker's bus to a main-side bus so existing
    // `pumpBusToSSE(c, bus, …)` calls keep working without change.
    const bus = createBus(new AbortController());
    const detachRuntimeLog = installRuntimeEventLog(bus, 'coder', sessionId);
    // Log the spawn on the brand-new bus — the dashboard's
    // WorkerLogPanel will show "worker spawned (boot=Xms)" as the
    // first event of this run, before any runner events arrive.
    emitWorkerLog(bus, 'info', 'pool', `worker spawned (boot=${bootMs}ms)`, {
      sessionId,
      bootMs,
    });
    const bridge = host.requireBridge();
    // ─── Wire RPC bridges from worker → main ─────────────────────────
    // Worker boot installs a `DocSearchBackend` shim that calls
    // `bridge.request('docSearch', ...)`. The corresponding handler
    // lives HERE — routes the request to the main-process singleton.
    // Without this, `rag_search_docs` from inside the worker fails
    // with "doc corpus backend is not wired into this process" — the
    // singleton set via `setGlobalDocSearch` in server.ts lives in the
    // main-thread module instance and worker_threads don't share module
    // state.
    //
    // Same pattern for `docs_deep_research` via `DocsResearchBridge`.
    //
    // Handlers degrade gracefully when the deps box is empty (tests,
    // headless runs) — they throw an error whose message matches the
    // in-process "not configured" message so the worker shim can
    // forward it verbatim.
    const offDocSearch = bridge.handle('docSearch', async (payload) => {
      const backend = this.opts.docDeps?.docSearch;
      if (!backend) {
        throw new Error(
          'rag_search_docs is not configured: the doc corpus backend is not wired into this process. Ask the user to ensure the Documentação feature is enabled.',
        );
      }
      return backend.search(payload as Parameters<DocSearchBackend['search']>[0]);
    });
    const offDocsResearch = bridge.handle('docsResearch', async (payload) => {
      const researcher = this.opts.docDeps?.docsResearch;
      if (!researcher) {
        throw new Error(
          'docs_deep_research is not configured: no DocsResearchBridge installed. Use rag_search_docs as a fallback.',
        );
      }
      return researcher.runResearch(payload as Parameters<DocsResearchBridge['runResearch']>[0]);
    });
    // Preview DevTools — routes to the main-process PreviewWindowService
    // (set by the Electron main via setGlobalPreviewDevtools). Unset in
    // headless → the tool surfaces a friendly "unavailable" error.
    const offPreviewDevtools = bridge.handle('previewDevtools', async (payload) => {
      const svc = getGlobalPreviewDevtools();
      if (!svc) throw new Error('Preview DevTools unavailable — only in the desktop app with a preview open.');
      return svc.invoke(payload as PreviewInvoke);
    });
    // Vision fallback — routes image→text describe to the main-process vision
    // describer (resolves the code-agent/vision Pipelines role + runs a one-off
    // chat). Unset/unbound → throws VISION_NOT_CONFIGURED; the worker-side
    // transform catches it and keeps the raw image + a note.
    const offVisionDescribe = bridge.handle('visionDescribe', async (payload) => {
      const v = this.opts.docDeps?.vision;
      if (!v) {
        throw new Error(
          'VISION_NOT_CONFIGURED: no vision model is bound. Set the code-agent / vision role in Settings → Pipelines.',
        );
      }
      return v.describe(payload as VisionDescribeRequest);
    });

    // ─── External-MCP pool bridge ─────────────────────────────────────
    // Worker's `RemoteMcpServerManager` requests a snapshot once per run
    // (in `connectAll()`) and routes every tool invocation through
    // `mcpExt.callTool`. The pool field is mutable on `opts` because
    // the singleton wire-up sets it after the pool finishes booting
    // (server.ts boots Hono synchronously, then awaits pool.boot()).
    const offMcpSnapshot = bridge.handle('mcpExt.snapshot', async () => {
      const pool = this.opts.getMcpExternalPool?.() ?? null;
      if (!pool) {
        // Empty snapshot keeps the worker happy — `extTools.length > 0`
        // gate in runCoder simply skips external registration.
        return {
          tools: [],
          tierMap: [],
          states: [],
          customTierSummary: [],
          enabledServers: [],
          connectedCount: 0,
        };
      }
      return pool.getSnapshot();
    });
    const offMcpCallTool = bridge.handle('mcpExt.callTool', async (payload) => {
      const pool = this.opts.getMcpExternalPool?.() ?? null;
      if (!pool) {
        return { ok: false, text: 'External MCP pool not configured in this http-api process.' };
      }
      const p = payload as { serverId: string; toolName: string; args: Record<string, unknown> };
      return pool.callTool(p.serverId, p.toolName, p.args);
    });

    const offEvent = bridge.on('bus.event', (payload) => {
      const env = payload as { runId?: number; event: string; data: unknown };
      const e = this.entries.get(sessionId);
      if (!e || env.runId !== e.currentRunId) return;
      // (A) — worker activity refreshes the idle timer. Without this, a
      // slow provider (LLM thinking 6+ min on a fat prompt) looks idle
      // to the sweep and gets evicted mid-turn (session 798 symptom).
      // Bus events flow continuously while the worker is doing real
      // work (heartbeats every 10s, text/tool deltas, dispatch
      // progress) — so any single such event resets `lastTouchedAt`
      // far below the 5-min TTL.
      e.lastTouchedAt = Date.now();
      publish(e.bus, env.event, env.data);
    });
    const offEnd = bridge.on('bus.end', (payload) => {
      const env = payload as { runId?: number; event: 'done' | 'error'; data: unknown };
      const e = this.entries.get(sessionId);
      if (!e || env.runId !== e.currentRunId) return;
      if (!e.bus.ended) {
        markEnded(e.bus, env.event, env.data);
      }
      // (B) — terminal event: run is no longer in progress; sweep may
      // now consider this entry for eviction once ttlMs elapses without
      // a follow-up `runFresh`/`pushUserMessage`.
      e.runInProgress = false;
      // Fast-evict on run completion. We can't synchronously evict
      // here because a follow-up `/messages` POST may arrive within
      // a few seconds and would have to pay the cold-start cost
      // again. The linger window (default 30 s) gives the dashboard
      // and the user time to chain another turn through the same
      // worker. Any `runFresh` / `pushUserMessage` during that
      // window cancels the timer.
      this.schedulePostRunEvict(e, sessionId);
    });

    let entry: PoolEntry;
    entry = {
      host,
      bus,
      currentRunId: 0,
      lastTouchedAt: Date.now(),
      detachCurrentBusRuntimeLog: detachRuntimeLog,
      postRunEvictTimer: null,
      // Fresh entries are inert until the first `runFresh`. The sweep
      // never sees them in this state because `lastTouchedAt` was just
      // bumped by `ensureEntry`, but the explicit `false` documents
      // intent.
      runInProgress: false,
      detachBusMirror: () => {
        try { entry.detachCurrentBusRuntimeLog(); } catch { /* best-effort */ }
        try { offEvent(); } catch { /* best-effort */ }
        try { offEnd(); } catch { /* best-effort */ }
        try { offDocSearch(); } catch { /* best-effort */ }
        try { offDocsResearch(); } catch { /* best-effort */ }
        try { offPreviewDevtools(); } catch { /* best-effort */ }
        try { offVisionDescribe(); } catch { /* best-effort */ }
        try { offMcpSnapshot(); } catch { /* best-effort */ }
        try { offMcpCallTool(); } catch { /* best-effort */ }
      },
    };
    this.entries.set(sessionId, entry);
    return entry;
  }
}
