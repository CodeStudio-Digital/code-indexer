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
import type { DocSearchBackend } from '@mcp/code-agent/tools/rag-search-docs.js';
import { getGlobalPreviewDevtools, type PreviewInvoke } from '@mcp/code-agent/tools/preview/index.js';
import type { VisionDescribeRequest } from '@mcp/code-agent/core/vision-describer.js';
import type { DocsResearchBridge } from '@mcp/docs-agent/bridges/docs-bridge.js';
import type { CoderWorkerDocDeps } from './CoderWorkerPool.js';
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
import { installRuntimeEventLog } from './runtime-event-log.js';
import { registerWorkerMemoryHandlers } from './worker-memory-handlers.js';
import { registerWorkerSecretsHandlers } from './worker-secrets-handlers.js';
import { registerWorkerLspHandlers } from './worker-lsp-handlers.js';

interface PoolEntry {
  host: WorkerHost;
  orchestrator: WorkerBackedOrchestrator;
  bus: CoderRunBus;
  lastTouchedAt: number;
  /**
   * Set to a timestamp while the master is blocked on a human
   * plan/question (`ask_user` / `submit_plan`). A session waiting on the
   * human is the LEAST idle thing there is, so the idle-TTL sweep must
   * not evict it — otherwise the human's eventual answer 404s with
   * "Session is no longer active". Cleared when the prompt resolves or
   * is cancelled. Bounded by `AWAITING_HUMAN_TTL_MS` so a truly
   * abandoned session is still reclaimed eventually.
   */
  awaitingHumanSince: number | null;
  qualityEnabled: boolean;
  /** Aggregated subscription cleanup. */
  detachBusMirror: () => void;
}

/**
 * Worker bus events that mean the master just blocked on / unblocked from
 * a human interaction. Used to pin the pool entry against idle eviction
 * for as long as the human hasn't responded.
 */
const AWAIT_HUMAN_START_EVENTS = new Set(['master_question_posted', 'master_plan_posted']);
const AWAIT_HUMAN_END_EVENTS = new Set([
  'master_question_resolved',
  'master_plan_resolved',
  'master_prompt_cancelled',
]);

/**
 * Absolute ceiling on how long a human-blocked worker is kept warm.
 * Covers virtually any real human response time (think, walk away, come
 * back) while still reclaiming a session the human silently abandoned.
 */
const AWAITING_HUMAN_TTL_MS = 60 * 60 * 1000;

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
  /**
   * Mutable doc-corpus deps box. Mutated by the singleton wire-up
   * (`setCompanyWorkerDocDeps` in `workerPoolSingleton.ts`); each `spawn()`
   * wires bridge handlers that route `rag_search_docs` / `docs_deep_research`
   * from inside the company-worker BACK to these main-thread singletons via
   * MessageBridge RPC. Worker-side shims live in
   * `apps/http-api/workers/company-worker.ts`. Mirrors `CoderWorkerPool`.
   */
  docDeps?: CoderWorkerDocDeps;
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
    // Idle-eviction TTL. A company session is a human-in-the-loop workflow —
    // the operator reads the board, thinks, walks away — so the old 5-min
    // default reclaimed orchestrators mid-session and the next interaction
    // 404'd with "No active orchestrator". 30 min covers normal think-time;
    // a session actively blocked on a question/plan is pinned for 1h on top of
    // this (awaitingHumanSince). Override via CODER_COMPANY_ORCHESTRATOR_TTL_MS.
    this.ttlMs = opts.ttlMs ?? 30 * 60 * 1000;
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

  /**
   * Per-isolate heap stats for the admin perf monitor. Best-effort: a
   * worker that can't answer within the timeout reports `stats: null`.
   * Does NOT bump `lastTouchedAt` — observing a worker isn't activity.
   */
  async memStats(
    timeoutMs = 2_000,
  ): Promise<Array<{ sessionId: number; stats: import('../workers/perf-stats.js').WorkerMemStats | null }>> {
    const jobs = Array.from(this.entries.entries()).map(async ([sessionId, entry]) => {
      try {
        const stats = (await entry.host
          .requireBridge()
          .request('perf.memStats', {}, { timeoutMs })) as import('../workers/perf-stats.js').WorkerMemStats;
        return { sessionId, stats };
      } catch {
        return { sessionId, stats: null };
      }
    });
    return Promise.all(jobs);
  }

  qualitySnapshot(): Array<{ sessionId: number; enabled: boolean }> {
    return [...this.entries.entries()].map(([sessionId, entry]) => ({
      sessionId,
      enabled: entry.qualityEnabled,
    }));
  }

  async refreshQualityStatus(timeoutMs = 2_000): Promise<Array<{ sessionId: number; enabled: boolean }>> {
    await Promise.all([...this.entries.values()].map(async (entry) => {
      try {
        const status = await entry.host.requireBridge().request<{ enabled: boolean }>(
          'quality.status',
          {},
          { timeoutMs },
        );
        entry.qualityEnabled = status.enabled === true;
      } catch {
        entry.qualityEnabled = false;
      }
    }));
    return this.qualitySnapshot();
  }

  async setQualityEnabled(enabled: boolean, timeoutMs = 5_000): Promise<{
    total: number;
    acknowledged: number;
    failed: number;
  }> {
    const entries = [...this.entries.values()];
    let acknowledged = 0;
    await Promise.all(entries.map(async (entry) => {
      try {
        const ack = await entry.host.requireBridge().request<{ enabled: boolean }>(
          'quality.setEnabled',
          { enabled },
          { timeoutMs },
        );
        if (ack.enabled === enabled) {
          entry.qualityEnabled = enabled;
          acknowledged += 1;
        }
      } catch { /* reflected in failed */ }
    }));
    return { total: entries.length, acknowledged, failed: entries.length - acknowledged };
  }

  /** V8 CPU profile of one session's worker isolate (admin perf panel). */
  async cpuProfile(sessionId: number, durationMs: number): Promise<object | null> {
    const entry = this.entries.get(sessionId);
    if (!entry) return null;
    return (await entry.host
      .requireBridge()
      .request('perf.cpuProfile', { durationMs }, { timeoutMs: durationMs + 10_000 })) as object;
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
      // A master blocked on a human plan/question is not idle — it's
      // waiting for the user. Keep it warm (up to AWAITING_HUMAN_TTL_MS)
      // so the answer doesn't 404 when it finally arrives.
      if (entry.awaitingHumanSince != null) {
        if (now - entry.awaitingHumanSince <= AWAITING_HUMAN_TTL_MS) continue;
        this.log(
          'warn',
          `[pool] session=${id} awaited human >${Math.round(AWAITING_HUMAN_TTL_MS / 60000)}min with no answer — reclaiming`,
        );
      }
      if (now - entry.lastTouchedAt > this.ttlMs) {
        void this.evict(id);
      }
    }
  }

  private async spawn(sessionId: number): Promise<PoolEntry> {
    // Create the main-side bus up front so `onCrash` can mark it ended.
    // Otherwise a worker that dies before emitting `bus.end` leaves any
    // attached SSE stream blocked in `waitEnded` until the client
    // disconnects (the heartbeat keeps the socket warm) — a hung tab.
    const bus = createBus(new AbortController());
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
        // Unblock any SSE stream attached to this session so it closes
        // cleanly instead of hanging until the client disconnects.
        try {
          if (!bus.ended) {
            markEnded(bus, 'error', { reason: 'worker_crashed', message: err.message });
          }
        } catch {
          /* best-effort */
        }
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
    // (the bus itself is created at the top of spawn so `onCrash` can end it)
    const detachRuntimeLog = installRuntimeEventLog(bus, 'company', sessionId);
    const bridge = host.requireBridge();
    let effectiveQualityEnabled = false;
    try {
      const status = await bridge.request<{ enabled: boolean }>('quality.status', {}, { timeoutMs: 5_000 });
      effectiveQualityEnabled = status.enabled === true;
    } catch {
      // Keep false: status must reflect an ACK, never the desired spawn input.
    }

    // ─── Doc-corpus RPC bridges from worker → main ───────────────
    // The company-worker boot installs `DocSearchBackend` /
    // `DocsResearchBridge` shims that call `bridge.request('docSearch' /
    // 'docsResearch', ...)`. The corresponding handlers live HERE — they
    // route the request to the main-process singletons. Without this,
    // `rag_search_docs` / `docs_deep_research` from inside the company
    // worker fail with "doc corpus backend is not wired into this process"
    // — the singleton set via `setGlobalDocSearch` in server.ts lives in
    // the main-thread module instance and worker_threads don't share
    // module state. Mirrors `CoderWorkerPool` for the chat path.
    //
    // Handlers degrade gracefully when the deps box is empty (tests,
    // headless runs) — they throw an error whose message matches the
    // in-process "not configured" message so the worker shim can forward
    // it verbatim.
    const offDocSearch = bridge.handle('docSearch', async (payload) => {
      const backend = this.opts.docDeps?.docSearch;
      if (!backend) {
        throw new Error(
          'rag_search_docs is not configured: the doc corpus backend is not wired into this process. Ask the user to ensure the Documentação feature is enabled.',
        );
      }
      return backend.search(payload as Parameters<DocSearchBackend['search']>[0]);
    });
    // rag_read_doc — same deps box; the verb is optional on older backends
    // so the worker shim gets the same "not available" the in-process tool
    // would emit.
    const offDocReadChunk = bridge.handle('docReadChunk', async (payload) => {
      const backend = this.opts.docDeps?.docSearch;
      if (!backend?.readChunk) {
        throw new Error(
          'rag_read_doc is not available in this process (backend without readChunk). Use the rag_search_docs snippets instead.',
        );
      }
      return backend.readChunk(payload as Parameters<NonNullable<DocSearchBackend['readChunk']>>[0]);
    });
    // rag_read_doc mode:'section' — whole-section reassembly (optional verb).
    const offDocReadSection = bridge.handle('docReadSection', async (payload) => {
      const backend = this.opts.docDeps?.docSearch;
      if (!backend?.readSection) {
        throw new Error('section mode is not available in this process — call rag_read_doc without mode to read this chunk + neighbors.');
      }
      return backend.readSection(payload as Parameters<NonNullable<DocSearchBackend['readSection']>>[0]);
    });
    // rag_doc_outline — structural navigation (optional verb).
    const offDocOutline = bridge.handle('docOutline', async (payload) => {
      const backend = this.opts.docDeps?.docSearch;
      if (!backend?.outline) {
        throw new Error('rag_doc_outline is not available in this process. Use rag_search_docs instead.');
      }
      return backend.outline(payload as Parameters<NonNullable<DocSearchBackend['outline']>>[0]);
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
    // Role recommender — the autonomous CompanyScheduler in the worker asks the
    // main-thread embedding pipeline for a role per card. Degrades to an empty
    // recommendation (scheduler skips the card) when no recommender is wired.
    const offRecommend = bridge.handle('recommend', async (payload) => {
      const fn = this.opts.docDeps?.recommend;
      if (!fn) return { recommendations: [] };
      return fn(payload as Parameters<NonNullable<CoderWorkerDocDeps['recommend']>>[0]);
    });
    // Preview DevTools — same main-process service as the coder pool, so
    // company subordinates get the preview/devtools tools too.
    const offPreviewDevtools = bridge.handle('previewDevtools', async (payload) => {
      const svc = getGlobalPreviewDevtools();
      if (!svc) throw new Error('Preview DevTools unavailable — only in the desktop app with a preview open.');
      return svc.invoke(payload as PreviewInvoke);
    });
    // Vision fallback — same main-process describer as the coder pool.
    const offVisionDescribe = bridge.handle('visionDescribe', async (payload) => {
      const v = this.opts.docDeps?.vision;
      if (!v) {
        throw new Error(
          'VISION_NOT_CONFIGURED: no vision model is bound. Set the code-agent / vision role in Settings → Pipelines.',
        );
      }
      return v.describe(payload as VisionDescribeRequest);
    });
    // Project memory (Mem C) — master + every subordinate runner inside this
    // company-worker reach the canonical MemoryRetriever + RunEndMemory
    // (server/deps.ts) through these handlers. Worker-side consumers:
    // `setCompanyMemoryPorts` in company-worker.ts (spawn-time PROJECT MEMORY
    // block + run-end distillation for subordinates).
    const offMemory = registerWorkerMemoryHandlers(bridge, () => this.opts.docDeps);
    // Secret decryption (`enc:`/`plain:` blobs) — safeStorage lives only in
    // the Electron main process; db_* tools in the worker RPC here.
    const offSecrets = registerWorkerSecretsHandlers(bridge);
    // Agent LSP nav for master + subordinates — same main-side router.
    const offLsp = registerWorkerLspHandlers(bridge);

    // Keep the pool entry warm while the worker is doing observable work.
    // The TTL sweep evicts on `lastTouchedAt`, which `getOrSpawn`/`get`/RPC
    // bump — but a backgrounded master start/resume (sandbox provision +
    // runCoder boot) emits no RPC from the main thread, only bus events. A
    // cold container rebuild can outlast the idle TTL, so without this a
    // long provision could be swept mid-build. Touching on every mirrored
    // event resets the idle clock as provisioning/run progress streams.
    const touch = (): void => {
      const e = this.entries.get(sessionId);
      if (e) e.lastTouchedAt = Date.now();
    };
    const offEvent = bridge.on('bus.event', (payload) => {
      const env = payload as { event: string; data: unknown };
      touch();
      // Pin / unpin the entry against idle eviction while the master is
      // blocked waiting for a human answer. See PoolEntry.awaitingHumanSince.
      if (AWAIT_HUMAN_START_EVENTS.has(env.event)) {
        const e = this.entries.get(sessionId);
        if (e) e.awaitingHumanSince = Date.now();
      } else if (AWAIT_HUMAN_END_EVENTS.has(env.event)) {
        const e = this.entries.get(sessionId);
        if (e) e.awaitingHumanSince = null;
      }
      // We don't preserve the worker's seq — `publish` allocates its
      // own monotonic seq on the main bus, which is what SSE clients
      // use as `Last-Event-ID`. Reusing worker seq would conflict
      // across reconnects.
      publish(bus, env.event, env.data);
    });
    // Batched high-volume deltas (text_delta / tool_progress /
    // operation_progress) coalesced worker-side into one message — see
    // company-worker.ts. Republish each through the SAME `publish` path so
    // seq allocation, the replay ring and Last-Event-ID stay identical to the
    // single-event path. Batches only ever carry coalescable `agent_event`
    // deltas (never the AWAIT_HUMAN master_* events), so no pin/unpin here.
    const offEventBatch = bridge.on('bus.event.batch', (payload) => {
      const env = payload as { events?: Array<{ event: string; data: unknown }> };
      if (!env || !Array.isArray(env.events)) return;
      touch();
      for (const e of env.events) {
        publish(bus, e.event, e.data);
      }
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
      // C1 — organism visibility: mirror the incident into the SESSION's
      // own metaBus (same bus the company SSE stream pumps), so the
      // session dashboard (autonomy feed + incident banner) sees it
      // without subscribing to the global Admin bus. The Admin bus above
      // stays untouched.
      try {
        publish(bus, 'supervisor_incident', {
          kind: incident.kind,
          agentRunId: incident.agentRunId ?? undefined,
          detail: incident.detail,
          detectedAtMs: incident.detectedAtMs,
        });
      } catch {
        /* best-effort */
      }
    });

    const detachBusMirror = (): void => {
      try { detachRuntimeLog(); } catch { /* best-effort */ }
      try { offEvent(); } catch { /* best-effort */ }
      try { offEventBatch(); } catch { /* best-effort */ }
      try { offEnd(); } catch { /* best-effort */ }
      try { offSupervisorBoot(); } catch { /* best-effort */ }
      try { offSupervisorIncident(); } catch { /* best-effort */ }
      try { offDocSearch(); } catch { /* best-effort */ }
      try { offDocReadChunk(); } catch { /* best-effort */ }
      try { offDocReadSection(); } catch { /* best-effort */ }
      try { offDocOutline(); } catch { /* best-effort */ }
      try { offDocsResearch(); } catch { /* best-effort */ }
      try { offRecommend(); } catch { /* best-effort */ }
      try { offPreviewDevtools(); } catch { /* best-effort */ }
      try { offVisionDescribe(); } catch { /* best-effort */ }
      try { offMemory(); } catch { /* best-effort */ }
      try { offSecrets(); } catch { /* best-effort */ }
      try { offLsp(); } catch { /* best-effort */ }
    };

    const orchestrator = createOrchestratorProxy(host, sessionId, bus);

    return {
      host,
      orchestrator,
      bus,
      lastTouchedAt: Date.now(),
      awaitingHumanSince: null,
      qualityEnabled: effectiveQualityEnabled,
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
