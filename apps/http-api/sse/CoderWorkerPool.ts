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
  type CoderRunBus,
} from '../coder-bus.js';
import type { CoderAttachment } from '@mcp/code-agent/index.js';

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
}

interface PoolEntry {
  host: WorkerHost;
  bus: CoderRunBus;
  lastTouchedAt: number;
  detachBusMirror: () => void;
  /**
   * Scheduled fast-eviction handle, set when `bus.end` arrives. Cleared
   * on the next `runFresh` / `pushUserMessage` so a re-engaged session
   * doesn't get evicted out from under the user.
   */
  postRunEvictTimer: ReturnType<typeof setTimeout> | null;
}

export interface RunFreshOpts {
  userMessage: string;
  attachments?: CoderAttachment[];
  maxTurns?: number;
  planMode?: boolean;
  agent?: 'explore' | 'plan' | 'build' | 'admin';
  profile?: 'bootstrap' | 'navigate' | 'full' | 'auto';
  /** POJO worktree opts — survives structuredClone across MessagePort. */
  worktree?: { name?: string; branch?: string };
  thinking?: boolean;
  /** Skill IDs the user pre-selected in the sidebar; forwarded to runCoder. */
  selectedSkillIds?: string[];
}

export class CoderWorkerPool {
  private readonly entries = new Map<number, PoolEntry>();
  private readonly ttlMs: number;
  private readonly postRunLingerMs: number;
  private readonly log: (level: 'info' | 'warn' | 'error', msg: string) => void;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

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
    this.cancelPostRunEvict(entry);
    entry.lastTouchedAt = Date.now();
    const bridge = entry.host.requireBridge();
    await bridge.request('runFresh', opts, { timeoutMs: 60_000 });
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
  async provideUserInput(sessionId: number, value: string): Promise<boolean> {
    const entry = this.entries.get(sessionId);
    if (!entry) return false;
    this.cancelPostRunEvict(entry);
    entry.lastTouchedAt = Date.now();
    const result = await entry.host
      .requireBridge()
      .request<{ ok: boolean }>('provideUserInput', { value });
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
        this.entries.delete(sessionId);
      },
      onError: (err) => {
        this.log('warn', `[coder-pool] worker session=${sessionId} error: ${err.message}`);
      },
    });
    const startedAt = Date.now();
    await host.start();
    this.log(
      'info',
      `[coder-pool] worker spawned session=${sessionId} (boot=${Date.now() - startedAt}ms)`,
    );

    // Mirror the worker's bus to a main-side bus so existing
    // `pumpBusToSSE(c, bus, …)` calls keep working without change.
    const bus = createBus(new AbortController());
    const bridge = host.requireBridge();
    const offEvent = bridge.on('bus.event', (payload) => {
      const env = payload as { event: string; data: unknown };
      publish(bus, env.event, env.data);
    });
    const offEnd = bridge.on('bus.end', (payload) => {
      const env = payload as { event: 'done' | 'error'; data: unknown };
      markEnded(bus, env.event, env.data);
      // Fast-evict on run completion. We can't synchronously evict
      // here because a follow-up `/messages` POST may arrive within
      // a few seconds and would have to pay the cold-start cost
      // again. The linger window (default 30 s) gives the dashboard
      // and the user time to chain another turn through the same
      // worker. Any `runFresh` / `pushUserMessage` during that
      // window cancels the timer.
      const e = this.entries.get(sessionId);
      if (!e) return;
      if (e.postRunEvictTimer) clearTimeout(e.postRunEvictTimer);
      e.postRunEvictTimer = setTimeout(() => {
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
      if (typeof (e.postRunEvictTimer as { unref?: () => void }).unref === 'function') {
        (e.postRunEvictTimer as { unref: () => void }).unref();
      }
    });

    const entry: PoolEntry = {
      host,
      bus,
      lastTouchedAt: Date.now(),
      postRunEvictTimer: null,
      detachBusMirror: () => {
        try { offEvent(); } catch { /* best-effort */ }
        try { offEnd(); } catch { /* best-effort */ }
      },
    };
    this.entries.set(sessionId, entry);
    return entry;
  }
}
