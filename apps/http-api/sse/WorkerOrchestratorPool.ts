/**
 * Pool of worker-backed CompanyOrchestrators.
 *
 * Each company session id maps to a `WorkerHost` running
 * `apps/http-api/workers/company-worker.ts`. The main thread interacts
 * with the orchestrator via a typed JS Proxy that forwards method calls
 * over `MessageBridge`. Workers are the ONLY path — there's no
 * in-process fallback. Consumers reach the pool via the small helper
 * in `companyOrchestrator.ts` (which most routes use directly).
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
 * Eviction: TTL-based. `evict()` sends a `stop` RPC for a graceful
 * shutdown, then waits for the worker to exit. Restart-on-crash is
 * delegated to the underlying `WorkerHost` (default 3 retries with
 * exponential backoff).
 */
import { WorkerHost } from '@mcp/orchestrator-host';
import type { CompanyOrchestrator } from '@mcp/company/orchestrator.js';
import {
  createBus,
  publish,
  markEnded,
  type CoderRunBus,
} from '../coder-bus.js';
import {
  publishSupervisorIncident,
  type SupervisorIncidentEnvelope,
} from './supervisor-incident-bus.js';

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
   * Phase 3.1 — call a supervisor method on the worker for a session.
   * Returns null when the session has no active worker (didn't spawn or
   * already evicted). Caller is responsible for catching timeouts.
   */
  async supervisorRpc<R = unknown>(
    sessionId: number,
    method: string,
    args: unknown[] = [],
  ): Promise<R | null> {
    const entry = this.entries.get(sessionId);
    if (!entry) return null;
    entry.lastTouchedAt = Date.now();
    const bridge = entry.host.requireBridge();
    return (await bridge.request('supervisor.rpc', { method, args }, { timeoutMs: 10_000 })) as R;
  }

  /** Iterate session ids of currently-active workers. */
  activeSessionIds(): number[] {
    return Array.from(this.entries.keys());
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

    // ─── Supervisor wire-back (Sprint 4 Phase 1.6) ───────────────
    //
    // Each company-worker boots its own AgentSupervisor (see
    // `apps/http-api/workers/company-worker.ts`). Incidents detected
    // there fire `supervisor.incident`; boot ack fires
    // `supervisor.boot`. Main side just logs — Phase 3 will pipe
    // these into a structured SSE topic for the dashboard.
    const offSupervisorBoot = bridge.on('supervisor.boot', (payload) => {
      const env = payload as { sessionId: number };
      console.log(`[supervisor:worker-${env.sessionId}] started (MCP_SUPERVISOR_ENABLED=1)`);
    });
    const offSupervisorIncident = bridge.on('supervisor.incident', (payload) => {
      const incident = payload as SupervisorIncidentEnvelope;
      const agentTag = incident.agentRunId == null ? 'n/a' : String(incident.agentRunId);
      console.warn(
        `[supervisor:worker-${incident.sessionId}] incident ${incident.kind}: agent=${agentTag} ${incident.detail}`,
      );
      // Phase 3.2 — fan-out to the process-wide incident bus so SSE
      // subscribers (dashboard) see the event live.
      try {
        publishSupervisorIncident(incident);
      } catch {
        /* best-effort */
      }
    });

    const detachBusMirror = (): void => {
      try { offEvent(); } catch { /* best-effort */ }
      try { offEnd(); } catch { /* best-effort */ }
      try { offSupervisorBoot(); } catch { /* best-effort */ }
      try { offSupervisorIncident(); } catch { /* best-effort */ }
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
