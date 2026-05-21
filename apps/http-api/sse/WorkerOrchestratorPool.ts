/**
 * Pool of worker-backed CompanyOrchestrators (P13).
 *
 * The legacy `orchestratorRegistry` holds in-process orchestrator
 * instances. This pool replaces the spawn path: each session id maps
 * to a `WorkerHost` that runs `apps/http-api/workers/company-worker.ts`.
 * The main thread interacts with the orchestrator via a typed JS
 * Proxy that forwards method calls over `MessageBridge`.
 *
 * Two facing surfaces:
 *
 *   1. `getOrSpawn(sessionId)` — returns a `WorkerBackedOrchestrator`
 *      with the same shape as `CompanyOrchestrator` (Proxy magic).
 *      Existing HTTP routes can treat the result as the original
 *      class because every method call dispatches via the bridge.
 *
 *   2. `getMirroredBus(sessionId)` — returns a main-side
 *      `CoderRunBus` whose events come from the worker's bus via
 *      `bridge.on('bus.event', ...)`. Routes that today do
 *      `pumpBusToSSE(c, orchestrator.metaBus, ...)` continue to work
 *      unchanged when they receive the bus from this pool.
 *
 * Eviction: TTL-based, same semantics as `OrchestratorRegistry`.
 * `evict()` sends a `stop` RPC for a graceful shutdown, then waits
 * for the worker to exit. Restart-on-crash is delegated to the
 * underlying `WorkerHost` (default 3 retries with exponential
 * backoff).
 */
import { WorkerHost } from '@mcp/orchestrator-host';
import type { CompanyOrchestrator } from '@mcp/company/orchestrator.js';
import {
  createBus,
  publish,
  markEnded,
  type CoderRunBus,
} from '../coder-bus.js';

interface PoolEntry {
  host: WorkerHost;
  orchestrator: WorkerBackedOrchestrator;
  bus: CoderRunBus;
  lastTouchedAt: number;
  /** Aggregated subscription cleanup. */
  detachBusMirror: () => void;
}

export interface WorkerOrchestratorPoolOpts {
  /** Absolute path Node spawns — built `.js` in prod, dev bootstrap `.mjs` in dev. */
  workerFile: string;
  /** Extra execArgv (currently unused; reserved for future loader tweaks). */
  workerExecArgv?: string[];
  /**
   * Dev-mode only: the real TS entry the bootstrap should
   * dynamic-import after registering tsx. Passed to the worker via
   * `workerData.tsEntry`. Undefined in production.
   */
  workerDevTsEntry?: string;
  /** SQLite path passed to each worker. */
  dbPath: string;
  /** Idle TTL before eviction. Default 5 min. */
  ttlMs?: number;
  /** Logger for diagnostic output. */
  log?: (level: 'info' | 'warn' | 'error', msg: string) => void;
}

/**
 * Main-side handle that mimics `CompanyOrchestrator`. Method access
 * proxies through `bridge.request('rpc', { path, args })`. Property
 * reads for primitives go through `orchestrator.property`. Anything
 * else (e.g. accessing `master`) returns a sub-proxy that prepends
 * its name to the rpc path on subsequent calls.
 *
 * Limitations:
 *   - All methods become async. Callers that expected sync returns
 *     (`isAlive`, `runningCount`, etc.) need to be updated. Most
 *     existing routes already `await` their orchestrator calls.
 *   - The actual class instance lives in the worker — `instanceof
 *     CompanyOrchestrator` checks return false. Don't rely on them.
 */
export type WorkerBackedOrchestrator = CompanyOrchestrator;

export class WorkerOrchestratorPool {
  private readonly entries = new Map<number, PoolEntry>();
  private readonly ttlMs: number;
  private readonly log: (level: 'info' | 'warn' | 'error', msg: string) => void;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly opts: WorkerOrchestratorPoolOpts) {
    this.ttlMs = opts.ttlMs ?? 5 * 60 * 1000;
    this.log = opts.log ?? ((level, msg) => console[level === 'info' ? 'log' : level](msg));
    // Periodic eviction sweep. Unref'd so it doesn't keep Node alive.
    this.sweepTimer = setInterval(() => this.sweep(), 60_000);
    if (this.sweepTimer && typeof (this.sweepTimer as { unref?: () => void }).unref === 'function') {
      (this.sweepTimer as { unref: () => void }).unref();
    }
  }

  /** Spawn (if needed) and return the worker-backed orchestrator + its mirrored bus. */
  async getOrSpawn(
    sessionId: number,
  ): Promise<{ orchestrator: WorkerBackedOrchestrator; bus: CoderRunBus }> {
    const existing = this.entries.get(sessionId);
    if (existing) {
      existing.lastTouchedAt = Date.now();
      return { orchestrator: existing.orchestrator, bus: existing.bus };
    }
    const entry = await this.spawn(sessionId);
    this.entries.set(sessionId, entry);
    return { orchestrator: entry.orchestrator, bus: entry.bus };
  }

  /** Return existing entry without spawning. */
  get(sessionId: number): { orchestrator: WorkerBackedOrchestrator; bus: CoderRunBus } | null {
    const entry = this.entries.get(sessionId);
    if (!entry) return null;
    entry.lastTouchedAt = Date.now();
    return { orchestrator: entry.orchestrator, bus: entry.bus };
  }

  has(sessionId: number): boolean {
    return this.entries.has(sessionId);
  }

  /**
   * Snapshot for the `/api/admin/workers` diagnostic endpoint. Returns
   * one row per active session — id, worker uptime, last-touched
   * timestamp, and the WorkerHost's lifecycle state.
   */
  snapshot(): Array<{
    sessionId: number;
    workerState: string;
    lastTouchedAt: number;
    /** ms since `lastTouchedAt` — operator's "is this idle?" hint. */
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

  /** Gracefully evict a session — sends `stop` and waits for worker exit. */
  async evict(sessionId: number): Promise<void> {
    const entry = this.entries.get(sessionId);
    if (!entry) return;
    this.entries.delete(sessionId);
    entry.detachBusMirror();
    const aliveMs = Date.now() - entry.lastTouchedAt;
    try {
      await entry.host.evict(5_000);
      this.log('info', `[pool] company worker evicted session=${sessionId} (idle=${aliveMs}ms)`);
    } catch (err) {
      this.log('warn', `[pool] evict session=${sessionId} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Tear down everything. Returns when every worker has exited. */
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

  private async spawn(sessionId: number): Promise<PoolEntry> {
    const host = new WorkerHost({
      name: `company-session-${sessionId}`,
      workerFile: this.opts.workerFile,
      workerData: {
        companySessionId: sessionId,
        dbPath: this.opts.dbPath,
        // Dev bootstrap reads this to dynamic-import the real TS entry
        // after registering tsx. Absent in production builds.
        tsEntry: this.opts.workerDevTsEntry,
      },
      execArgv: this.opts.workerExecArgv,
      maxRestarts: 3,
      defaultRequestTimeoutMs: 60_000, // LLM-bound calls can take a while
      onCrash: (err) => {
        this.log('error', `[pool] worker session=${sessionId} crashed permanently: ${err.message}`);
        this.entries.delete(sessionId);
      },
      onError: (err) => {
        this.log('warn', `[pool] worker session=${sessionId} error: ${err.message}`);
      },
    });
    const startedAt = Date.now();
    await host.start();
    this.log(
      'info',
      `[pool] company worker spawned session=${sessionId} (boot=${Date.now() - startedAt}ms)`,
    );

    // ─── Bus mirror — worker → main ─────────────────────────────
    const bus = createBus(new AbortController());
    const bridge = host.requireBridge();
    const offEvent = bridge.on('bus.event', (payload) => {
      const env = payload as { event: string; data: unknown };
      // We don't preserve the worker's seq — `publish` allocates its
      // own monotonic seq on the main bus, which is what SSE clients
      // use as `Last-Event-ID`. Reusing worker seq would conflict
      // across reconnects.
      publish(bus, env.event, env.data);
    });
    const offEnd = bridge.on('bus.end', (payload) => {
      const env = payload as { event: 'done' | 'error'; data: unknown };
      markEnded(bus, env.event, env.data);
    });

    const detachBusMirror = (): void => {
      try { offEvent(); } catch { /* best-effort */ }
      try { offEnd(); } catch { /* best-effort */ }
    };

    const orchestrator = createOrchestratorProxy(host, sessionId, bus);

    return {
      host,
      orchestrator,
      bus,
      lastTouchedAt: Date.now(),
      detachBusMirror,
    };
  }
}

/**
 * Build the typed Proxy that mimics CompanyOrchestrator's surface.
 *
 * Key trick: when the consumer accesses `orch.master`, we return ANOTHER
 * proxy with the path prepended (`['master']`). Calling
 * `.sendUserMessage(...)` on that nested proxy sends an `rpc` request
 * with `{ path: ['master', 'sendUserMessage'], args: [...] }` to the
 * worker.
 *
 * Special cases:
 *   - `companySessionId`, `parentSessionId` — read-only primitive
 *     properties known to live on the orchestrator itself. We cache
 *     `companySessionId` immediately and forward others via
 *     `orchestrator.property`. Returning a Promise for these would
 *     break code that does `orch.companySessionId` synchronously.
 *   - `metaBus` — returns the MAIN-SIDE mirrored bus directly. Routes
 *     that pump SSE from `orchestrator.metaBus` keep working.
 */
function createOrchestratorProxy(
  host: WorkerHost,
  sessionId: number,
  bus: CoderRunBus,
): WorkerBackedOrchestrator {
  const bridge = host.requireBridge();
  function makeProxy(path: string[]): unknown {
    return new Proxy(
      function _stub() {
        /* function body is never invoked — call traps it below */
      },
      {
        get(_target, prop, _receiver) {
          if (typeof prop === 'symbol') return undefined;
          // Synchronous, known-safe properties at the root.
          if (path.length === 0) {
            if (prop === 'companySessionId') return sessionId;
            if (prop === 'metaBus') return bus;
            if (prop === 'then') return undefined; // not thenable — don't unwrap as a promise
          }
          // Nested access — return a new proxy with the extended path.
          return makeProxy([...path, prop]);
        },
        apply(_target, _thisArg, args) {
          // Function call: dispatch the RPC. Caller MUST `await` the result.
          return bridge.request('rpc', { path, args }, { timeoutMs: 60_000 });
        },
        // Block accidental writes — orchestrator state lives in the worker.
        set() {
          throw new Error('WorkerBackedOrchestrator is read-only on the main thread');
        },
      },
    );
  }
  // Cast through unknown — the proxy SHAPE matches CompanyOrchestrator
  // at the type level even though the implementation is dynamic.
  return makeProxy([]) as unknown as WorkerBackedOrchestrator;
}
