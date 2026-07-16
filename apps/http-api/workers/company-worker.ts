/**
 * Company-session worker entrypoint (P13).
 *
 * One worker_thread per active `company_session_id`. The worker:
 *   1. Opens its own SQLite handle in WAL mode (sibling reads concurrent
 *      with the main thread's writes — see `@mcp/orchestrator-host/DbConnection`).
 *   2. Constructs a fresh `CompanyStore` + `CodeIndexDB` pair against
 *      that handle. Each worker owns its own ORM stack.
 *   3. Instantiates `CompanyOrchestrator`, capturing its `metaBus`.
 *   4. Subscribes to every meta-bus event and forwards them to main via
 *      `MessageBridge.emit('bus.event', { event, data, seq })`. Main
 *      mirrors them into a synthetic `CoderRunBus` so the existing
 *      `pumpBusToSSE` pipeline keeps working untouched.
 *   5. Registers RPC handlers via `bridge.handle(method, ...)` so the
 *      main-side proxy can call orchestrator methods by name.
 *   6. Emits `worker.ready` once everything is wired.
 *
 * Worker shutdown: the main thread sends `stop`; the worker calls
 * `orchestrator.abortAll()` and process-exits. `DbConnection.close()`
 * runs in the `exit` hook.
 *
 * Importantly: this file imports the FULL `@mcp/company` graph plus
 * the store stack. Boot time is measured in ~200–500 ms per worker on
 * dev hardware. Cold-start is dominated by `better-sqlite3` and the
 * orchestrator's service wiring; the LLM provider modules are lazy
 * (loaded on first `runCoder`).
 */
// IMPORTANT: workers import via relative paths only. Node's loader
// runs before tsx/tsconfig `paths` get a chance inside a worker_thread,
// so `@mcp/*` aliases throw "Cannot find package". Relative paths
// resolve identically under tsx, tsc and raw node.
import { parentPort, workerData } from 'node:worker_threads';
import { installLlmDispatcher } from '../install-llm-dispatcher.js';
import { closeDbWriter } from '../../../packages/indexer/src/workers/dbWriter/client.js';
import {
  MessageBridge,
  openWorkerDb,
  type MessageBridgeOpts,
} from '../../../packages/orchestrator-host/src/index.js';

// Streaming-resilient global undici dispatcher for THIS worker realm — every
// worker_thread has its own, so install before any provider fetch.
installLlmDispatcher();
import { CompanyStore } from '../../../packages/store/src/company-store.js';
import { CodeIndexDB } from '../../../packages/store/src/db.js';
import { hydrateWorkerCapabilities } from './worker-capabilities.js';
import { DesignSystemStore } from '../../../packages/store/src/design-system-store.js';
import { ApiClientStore } from '../../../packages/store/src/api-client-store.js';
import { setApiClientStore } from '../../../packages/code-agent/src/tools/api-client/index.js';
import { DbClientStore } from '../../../packages/store/src/db-client-store.js';
import { setDbToolsStores, setDbSecretDecryptor } from '../../../packages/code-agent/src/tools/db/index.js';
import { SkillStore } from '../../../packages/store/src/skill-store.js';
import { CompanySessionEnvStore } from '../../../packages/store/src/company-session-env-store.js';
import { QaTestRunStore } from '../../../packages/services/src/qa/store/qa-test-run-store.js';
import { CompanyServiceTransitionsStore } from '../../../packages/store/src/company-service-transitions-store.js';
import { CompanyServiceLogsStore } from '../../../packages/store/src/company-service-logs-store.js';
import { CompanySandboxServicesHealth } from '../../../packages/store/src/company-sandbox-services-health.js';
import { CompanySandboxServicesStore } from '../../../packages/store/src/company-sandbox-services-store.js';
import { CompanyLocalProjectStore } from '../../../packages/store/src/company-local-project-store.js';
import { setServiceSupervisorStores } from '../../../packages/company/src/services/service-supervisor/stores.js';
import { CompanyOrchestrator } from '../../../packages/company/src/orchestrator.js';
import { COOLDOWN_RESURRECT_MS } from '../../../packages/company/src/services/RuntimeReconciler.js';
import {
  setDesignSystemStore,
  setDesignSystemSkillStore,
} from '../../../packages/company/src/tools/design-system/index.js';
import {
  setAppStudioDbClientStore,
  setAppStudioStore,
} from '../../../packages/company/src/tools/app-studio/index.js';
import { AppStudioStore } from '../../../packages/store/src/app-studio-store.js';
import { VerdaccioStore } from '../../../packages/store/src/verdaccio-store.js';
import {
  VerdaccioService,
  setVerdaccioService,
} from '../../../packages/services/src/verdaccio/verdaccio-service.js';
import {
  setQaTestRunStore,
  setQaEndpointEnvStore,
} from '../../../packages/company/src/tools/qa/index.js';
import { setEnvToolStore } from '../../../packages/company/src/tools/env-tools.js';
import {
  startAgentSupervisorIfEnabled,
  setGlobalAgentSupervisor,
  SqliteSupervisionPersistence,
  type AgentSupervisor,
  type SupervisionPersistence,
} from '../../../packages/company/src/services/supervisor/index.js';
import { subordinateCompletionBus } from '../../../packages/company/src/services/subordinate/completion-events.js';
import {
  setGlobalDocSearch,
  type DocSearchBackend,
} from '../../../packages/code-agent/src/tools/rag-search-docs.js';
import {
  setGlobalCompanyRecommend,
  type CompanyRecommendFn,
} from '../../../packages/company/src/services/scheduler/recommend-shim.js';
import { setGlobalDocsHintProvider } from '../../../packages/code-agent/src/core/docs-hint.js';
import { DocStore } from '../../../packages/store/src/doc-store.js';
import {
  setGlobalPreviewDevtools,
  type IPreviewDevtools,
  type PreviewInvoke,
} from '../../../packages/code-agent/src/tools/preview/index.js';
import {
  setGlobalVisionDescriber,
  type IVisionDescriber,
  type VisionDescribeRequest,
} from '../../../packages/code-agent/src/core/vision-describer.js';
import {
  setGlobalDocsResearcher,
  type DocsResearchBridge,
} from '../../../packages/docs-agent/src/bridges/docs-bridge.js';
import type { DocsResearchResult } from '../../../packages/docs-agent/src/types.js';
import { setCompanyMemoryPorts } from '../../../packages/company/src/services/memory/ports.js';
import { buildWorkerMemoryShims } from './memory-shims.js';
import { setInvestigationSemanticIndex } from '../../../packages/code-agent/src/tools/investigation-embedder.js';
import { installWorkerLspShim } from './lsp-shim.js';
import { registerPerfStatsHandler } from './perf-stats.js';
import { registerWorkerPluginProviders } from './worker-plugin-providers.js';
import { installWorkerQualityWiring } from './quality-wiring.js';
import { subscribe, publish, markEnded, type CoderRunBus } from '../coder-bus.js';

interface CompanyWorkerData {
  companySessionId: number;
  dbPath: string;
}

interface BusEventEnvelope {
  seq: number;
  event: string;
  data: unknown;
}

interface BusEndEnvelope {
  event: 'done' | 'error';
  data: unknown;
}

const port = parentPort;
if (!port) throw new Error('company-worker.ts: not running inside a worker_thread');

const { companySessionId, dbPath } = workerData as CompanyWorkerData;

// Open a dedicated SQLite connection in WAL mode. The shutdown hook
// flushes it on process exit so the main thread doesn't see a
// half-written WAL on next boot.
const dbConn = openWorkerDb({ dbPath });

// Per-model caps — module-global cache, re-hydrated per worker thread (see worker-capabilities.ts).
hydrateWorkerCapabilities(dbConn.handle, `company-worker ${companySessionId}`);

// Quality classifiers — worker_threads don't share module state, so the
// quality globals installed in server.ts (main thread) are NULL here. The
// main Company CoderRunner instances fire completed-round assessment from INSIDE
// this worker when MCP_CODER_WORKER=1, so without this re-install Telemetry
// → Quality stays empty for company/subordinate runs. See quality-wiring.ts
// for the gaps vs main.
const qualityController = installWorkerQualityWiring(
  dbConn.handle,
  `company-worker ${companySessionId}`,
  process.env.MCP_PIPELINES_QUALITY_CLASSIFIERS === '1',
);

// Overlay declarative plugin providers into this worker's registry so the agent
// can resolve a plugin-contributed provider kind (best-effort; built-ins always work).
registerWorkerPluginProviders();

// The bridge wires its message listener inside the constructor, so
// any request that races the orchestrator construction will be
// queued by the bridge and dispatched once we register handlers.
const bridge = new MessageBridge({
  // parentPort exposes the same `on(event, listener)` / `postMessage`
  // surface that MessageBridge expects from a MessagePortLike.
  port: port as unknown as MessageBridgeOpts['port'],
  onListenerError: (err, context) => {
    console.warn(`[company-worker ${companySessionId}] listener error in ${context}:`, err);
  },
});

// ─── Doc-corpus shim: route to the main process via RPC ──────────────
// `worker_threads` don't share module state, so the `setGlobalDocSearch`
// + `setGlobalDocsResearcher` singletons populated in server.ts on the
// main thread are NULL here. Without this shim, `rag_search_docs` from a
// subordinate runner inside THIS worker errors with "doc corpus backend
// is not wired into this process". We install a thin proxy that forwards
// every `search` / `runResearch` call back to the main thread via
// `bridge.request`; the corresponding handlers live in
// `apps/http-api/sse/WorkerOrchestratorPool.ts`. The actual
// `DocHybridSearch` + `DocsResearchBridge` instances live ONCE in the
// main process — zero duplication. Mirrors the coder-worker wiring.
//
// `docs_deep_research` additionally needs a per-runner
// `installDocsDeepResearch(runner)` call (it's not a always-registered
// bootstrap tool like `rag_search_docs`) — wired in the company runner
// paths (MasterLifecycle.wireAllForRunner + subordinate spawn).
const docSearchShim: DocSearchBackend = {
  search: async (input) =>
    bridge.request<Awaited<ReturnType<DocSearchBackend['search']>>>(
      'docSearch',
      input,
      { timeoutMs: 60_000 },
    ),
  // rag_read_doc — plain SQLite reads on the main side, so a short ceiling.
  readChunk: async (input) =>
    bridge.request<Awaited<ReturnType<NonNullable<DocSearchBackend['readChunk']>>>>(
      'docReadChunk',
      input,
      { timeoutMs: 15_000 },
    ),
  // rag_read_doc mode:'section' — whole-section reassembly (plain reads).
  readSection: async (input) =>
    bridge.request<Awaited<ReturnType<NonNullable<DocSearchBackend['readSection']>>>>(
      'docReadSection',
      input,
      { timeoutMs: 15_000 },
    ),
  // rag_doc_outline — heading tree / source list (plain reads).
  outline: async (input) =>
    bridge.request<Awaited<ReturnType<NonNullable<DocSearchBackend['outline']>>>>(
      'docOutline',
      input,
      { timeoutMs: 15_000 },
    ),
};
setGlobalDocSearch(docSearchShim);

// Role recommender shim → forwards to the main process (WorkerOrchestratorPool
// registers the `recommend` handler). The embedding pipeline + roleEmbeddingStore
// live ONCE on the main thread; the worker's CompanyScheduler reaches them
// through this RPC to resolve a role per card. A short ceiling — the call is
// just an embedding + scoring pass, not a container build.
setGlobalCompanyRecommend((input) =>
  bridge.request<Awaited<ReturnType<CompanyRecommendFn>>>('recommend', input, {
    timeoutMs: 15_000,
  }),
);

// Preview DevTools shim → forwards to the main process (WorkerOrchestratorPool
// registers the `previewDevtools` handler). Lets company subordinates use the
// preview/devtools tools, each scoped to its own window key.
const previewShim: IPreviewDevtools = {
  invoke: async (req: PreviewInvoke) =>
    bridge.request<unknown>('previewDevtools', req, { timeoutMs: 30_000 }),
};
setGlobalPreviewDevtools(previewShim);

// Vision describer shim → forwards to the main process (WorkerOrchestratorPool
// registers the `visionDescribe` handler), so company subordinates also get
// the image→text fallback when their model can't see.
const visionShim: IVisionDescriber = {
  describe: async (req: VisionDescribeRequest) =>
    bridge.request<string>('visionDescribe', req, { timeoutMs: 60_000 }),
};
setGlobalVisionDescriber(visionShim);

const docsResearcherShim = {
  runResearch: (input: Parameters<DocsResearchBridge['runResearch']>[0]): Promise<DocsResearchResult> =>
    bridge.request<DocsResearchResult>('docsResearch', input, { timeoutMs: 10 * 60_000 }),
} as unknown as DocsResearchBridge;
setGlobalDocsResearcher(docsResearcherShim);

// ─── Project-memory ports: route to the main process via RPC ─────────
// Spawn/resume (packages/company/services/subordinate/) read these via
// `getCompanyMemoryPorts()` to (a) render the PROJECT MEMORY system-prompt
// block from task-relevant snapshots and (b) hand memoryRetriever/
// runEndMemory to runCoder — per-turn injection + run-end distillation.
// The canonical MemoryRetriever/RunEndMemory live once in server/deps.ts;
// handlers in WorkerOrchestratorPool. MUST be set before the orchestrator
// is constructed so the very first spawn already sees the ports.
const memoryShims = buildWorkerMemoryShims(bridge);
setCompanyMemoryPorts(memoryShims);
setInvestigationSemanticIndex(memoryShims.investigationSemantic);

// Multi-language LSP nav for subordinate agents — RPC to the main-side
// router. Degrades to "TS only" when main hasn't wired the deps.
installWorkerLspShim(bridge);
// Per-isolate heap stats for the admin perf monitor (best-effort RPC).
registerPerfStatsHandler(bridge);

// Build the stores. Anti-freeze (Phase 2): ONE `CodeIndexDB` owns the worker's
// central connection and every sibling store shares its `db.raw()` handle
// (ownsHandle=false) — mirrors apps/http-api/server/deps.ts. Previously
// `CompanyStore` opened its OWN second writer on the same file, which (× the
// per-runCoder handles) starved the WAL during multi-agent runs.
const db = new CodeIndexDB(dbPath);
const companyStore = new CompanyStore(db.raw());

// ─── Company-tool store bindings (DS + QA) ──────────────────────
// worker_threads don't share module state, so the setDesignSystemStore()
// / setQaTestRunStore() calls in server.ts (main thread) leave these
// module-level bindings NULL here. Master + subordinates all run in THIS
// worker, so without this the ds_*/qa_* tools fail with "... not wired"
// (ds_get_session_info is the very first call of a Design System round).
// Re-wire against the worker's own DB handle — identical construction to
// apps/http-api/server/deps.ts, WAL handle shared (ownsConnection=false,
// so the existing stop-handler close on companyStore still covers it).
// Harmless when the feature is off: tool registration stays gated by
// designSystemEnabled in packages/code-agent/src/index.ts.
const rawDb = db.raw();
setDesignSystemStore(new DesignSystemStore(rawDb));
// App Studio store — mesma postura (module globals não cruzam workers).
setAppStudioStore(new AppStudioStore(rawDb));
// API client store for the `api_*` tools, re-wired per worker (module globals
// don't cross worker_threads).
setApiClientStore(new ApiClientStore(rawDb));
// db_* v2 tools — worker-local DbClientStore on the shared central handle
// (company sessions read central; per-project routing is a main-thread
// concern) + the session's linked projects via CompanyStore. Secrets are
// keychain-bound to the MAIN process → decrypt RPCs over the bridge
// (registered by WorkerOrchestratorPool via worker-secrets-handlers).
const dbClientStore = new DbClientStore(rawDb);
setDbToolsStores(dbClientStore, companyStore);
setAppStudioDbClientStore({
  listConnections: (projectId) => dbClientStore.listConnections(projectId),
  createConnection: (input) => dbClientStore.createConnection(input),
  updateConnection: (_projectId, id, patch) => dbClientStore.updateConnection(id, patch),
});
setDbSecretDecryptor((blob) =>
  bridge.request<string>('secretsDecrypt', { blob }, { timeoutMs: 10_000 }),
);
setDesignSystemSkillStore(new SkillStore(rawDb));
// <indexed-docs> hint provider — worker-local DocStore reads (two SELECTs
// per 30s/project; no RPC). Inlined for the same alias-resolution reason
// as the coder-worker: server/docs/search-backend.ts pulls `@mcp/*`
// aliases that don't resolve inside worker_threads.
const workerDocStore = new DocStore(rawDb);
setGlobalDocsHintProvider({
  listForProject: (projectId) => {
    try {
      return workerDocStore.listCollectionsForProject(projectId).map((c) => ({
        name: c.name,
        description: c.description,
        chunk_count: c.chunk_count,
      }));
    } catch {
      // Pre-migration DB or transient read error — hint silently absent.
      return [];
    }
  },
});
// Verdaccio: setVerdaccioService() in server.ts is main-thread only, so
// ds_publish_version inside this worker found no service and failed with
// "VerdaccioService not wired" (pre-existing gap — the service reads all
// state from the DB, so a worker-local instance is equivalent to main's).
setVerdaccioService(new VerdaccioService({ store: new VerdaccioStore(rawDb) }));
setQaTestRunStore(new QaTestRunStore(rawDb));
// One CompanySessionEnvStore shared by BOTH the QA browser-endpoint tools and
// the env_* tools (env_list/env_read/env_set/…). Each has its own module-level
// binding that server.ts wires on the main thread; worker_threads don't share
// those globals, so master+subordinates running in THIS worker would otherwise
// hit "env tools unavailable (store not wired)". Re-wire both against the
// worker's own DB handle.
const sessionEnvStore = new CompanySessionEnvStore(rawDb);
setQaEndpointEnvStore(sessionEnvStore);
setEnvToolStore(sessionEnvStore);
// B1 — per-service transition audit + ring-buffered logs (mig 188), built on
// the worker's own shared handle like QaTestRunStore above.
const companyServiceTransitionsStore = new CompanyServiceTransitionsStore(rawDb);
const companyServiceLogsStore = new CompanyServiceLogsStore(rawDb);
// B3/B4/B5 — module bindings consumed by the ServiceSupervisor (health +
// transitions + structured log sink) and by the service_* / list_services
// tools (paged log reads + health projection). Worker-only by design: main
// never calls this setter, so these paths exist only where the supervisor
// and the company agents actually run.
setServiceSupervisorStores({
  health: new CompanySandboxServicesHealth(rawDb),
  transitions: companyServiceTransitionsStore,
  logs: companyServiceLogsStore,
  services: new CompanySandboxServicesStore(rawDb),
  // B8 — host-process discovery for the supervisor. The LocalProcessManager
  // singleton lives on the MAIN process; the worker sees the SQLite row.
  localProjects: new CompanyLocalProjectStore(rawDb),
});

// NOTE: this constructor synchronously wires every domain service.
// If any of them blocks on env vars, registered store factories, or
// network probes, the failure surfaces here BEFORE we report ready.
const orchestrator = new CompanyOrchestrator({
  companySessionId,
  companyStore,
  db,
});

// ─── AgentSupervisor (Sprint 4 Phase 1.6) ──────────────────────
//
// Each company-worker boots its OWN supervisor scoped to this session.
// Subscribes to:
//   - `orchestrator.eventBus` (exposed as public readonly in Phase 1.6
//      so the supervisor can observe master.ended / master.resurrected /
//      subordinates.changed lifecycle events that fire WITHIN this worker)
//   - `subordinateCompletionBus` (worker-local singleton — completion-handler
//      fires it in the same worker, so the supervisor receives it directly)
//
// Incidents are forwarded to main via `bridge.emit('supervisor.incident', ...)`
// where main's listener prints them as `[supervisor:worker-<sessionId>]` logs.
// This is what the user will see when an agent gets stuck.
//
// Gated by MCP_SUPERVISOR_ENABLED=1. setGlobalAgentSupervisor(...) makes the
// supervisor accessible to `spawn.ts:registerSubordinate` via the global
// singleton pattern (each worker's module scope has its own copy of `global.ts`
// — that's why the main-process call doesn't reach here, and why we MUST
// call it inside the worker too).
// Phase 2.4 — supervisor persistence is opt-in via env. When enabled,
// the supervisor reads `agent_supervision` on boot, detects ghost-running
// rows (process died mid-flight), and mirrors every state transition +
// incident to disk. The persistence opens its OWN better-sqlite3 handle
// against the same dbPath — WAL mode allows safe concurrent access.
let workerSupervisionPersistence: SupervisionPersistence | null = null;
if (process.env.MCP_SUPERVISOR_PERSISTENCE !== '0') {
  try {
    // Share the worker's ONE central handle (Phase 2) instead of opening a
    // separate writer connection to the same file.
    workerSupervisionPersistence = new SqliteSupervisionPersistence(db.raw());
  } catch (e) {
    console.warn(
      `[company-worker ${companySessionId}] failed to open supervisor persistence:`,
      e,
    );
  }
}

// Phase 2.2 — RecoveryContext bridges the supervisor to the
// orchestrator's public service methods. Each recovery action picks
// what it needs (some don't need master, some don't need runners).
const workerSupervisor: AgentSupervisor | null = startAgentSupervisorIfEnabled({
  companySessionId,
  companyEventBus: orchestrator.eventBus,
  completionBus: subordinateCompletionBus,
  emitIncident: (incident): void => {
    bridge.emit('supervisor.incident', {
      sessionId: companySessionId,
      ...incident,
    });
  },
  recoveryContext: {
    master: {
      isAlive: () => orchestrator.isMasterAlive,
      resurrect: (reason: string) =>
        Promise.resolve(orchestrator.notifyMasterAboutSubordinate(`[supervisor] ${reason}`)),
      // Shared dedup window (single source of truth — RuntimeReconciler exports
      // it): skip if a resurrect already fired so both watchers don't double-revive.
      recentlyResurrected: () => orchestrator.masterResurrectedWithinMs(COOLDOWN_RESURRECT_MS),
    },
    subordinates: {
      // Async signature on the public method; preserve it through.
      resume: (agentRunId, message) => orchestrator.resumeSubordinate(agentRunId, message),
      abort: (agentRunId) => Promise.resolve(orchestrator.abortSubordinate(agentRunId)),
      // Stalled-runner recovery: flip the DB status off 'running' + resume from
      // persisted state so a crashed subordinate stops showing "running".
      reestablish: (agentRunId, reason) => orchestrator.reestablishSubordinate(agentRunId, reason),
    },
    // Phase 2.3 — live view over the orchestrator's subordinate registry (no
    // parallel map to keep in sync). Subordinate runners are in-process in THIS
    // worker, so `injectToolResultError` unwedges a single stuck tool call
    // without terminating the run; falls back to `abort()` when inject misses.
    runners: {
      get: (agentRunId: number) => {
        const runner = orchestrator.getSubordinate(agentRunId)?.runner;
        if (!runner) return undefined;
        return {
          injectToolResultError: (toolUseId: string, msg: string) =>
            runner.injectToolResultError(toolUseId, msg),
          abort: () => runner.abort(),
        };
      },
    },
  },
  persistence: workerSupervisionPersistence ?? undefined,
});
setGlobalAgentSupervisor(workerSupervisor);
if (workerSupervisor) {
  // Boot ack so the user sees per-worker confirmation in the main log
  // (the main side's listener for `supervisor.boot` does the printing).
  bridge.emit('supervisor.boot', { sessionId: companySessionId });
}

// ─── Bus mirror — worker → main ─────────────────────────────────
//
// Subscribe to the orchestrator's metaBus and forward each event to
// the main thread. `since: -1` replays the entire buffer at attach
// time so events emitted between construction and the first
// subscriber don't get lost.
//
// COALESCING (anti-freeze): the master + EVERY subordinate runner publish
// their per-token `agent_event` deltas (text_delta / tool_progress /
// operation_progress) onto this one meta-bus. With N subordinates that is an
// N× firehose which, mirrored 1:1, saturates the MAIN event loop — each event
// costs one MessagePort message plus a synchronous SSE fan-out on the main
// side. We micro-batch ONLY those high-volume deltas into a single
// `bus.event.batch` message every `MCP_BUS_BATCH_MS` (default 16ms). Every
// other event (tool_call_start, *_posted, done, company lifecycle events, …)
// flushes the pending batch FIRST — preserving global ordering — then emits
// immediately exactly as before. Bus seq, the replay ring and Last-Event-ID
// are untouched: only the cross-thread transport batches.
const BUS_BATCH_MS = (() => {
  const raw = process.env.MCP_BUS_BATCH_MS;
  const n = raw == null ? NaN : Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 16;
})();
const COALESCABLE_INNER = new Set(['text_delta', 'tool_progress', 'operation_progress']);

let pendingEvents: BusEventEnvelope[] = [];
let batchTimer: ReturnType<typeof setTimeout> | null = null;

const flushPending = (): void => {
  if (batchTimer != null) {
    clearTimeout(batchTimer);
    batchTimer = null;
  }
  if (pendingEvents.length === 0) return;
  const events = pendingEvents;
  pendingEvents = [];
  bridge.emit('bus.event.batch', { events });
};

const isCoalescable = (ev: BusEventEnvelope): boolean => {
  if (ev.event !== 'agent_event') return false;
  const d = ev.data as { event?: unknown } | null;
  return (
    !!d &&
    typeof d === 'object' &&
    typeof d.event === 'string' &&
    COALESCABLE_INNER.has(d.event)
  );
};

const busUnsubscribe = subscribe(
  orchestrator.metaBus,
  (ev) => {
    const envelope: BusEventEnvelope = { seq: ev.seq, event: ev.event, data: ev.data };
    if (BUS_BATCH_MS > 0 && isCoalescable(envelope)) {
      pendingEvents.push(envelope);
      if (batchTimer == null) {
        batchTimer = setTimeout(flushPending, BUS_BATCH_MS);
        // Don't let a pending flush keep the worker alive on its own — the
        // stop handler + endListener flush explicitly on a clean shutdown.
        if (typeof (batchTimer as { unref?: () => void }).unref === 'function') {
          (batchTimer as { unref: () => void }).unref();
        }
      }
      return;
    }
    // Non-coalescable: flush buffered deltas BEFORE this event so ordering is
    // preserved (a tool_call_start / done can never overtake its text), then
    // emit immediately as before.
    flushPending();
    bridge.emit('bus.event', envelope);
  },
  -1,
);

// Mirror the terminal event so the main-side bus also resolves
// `waitEnded`. Flush buffered deltas first so a `done`/`error` can never
// overtake the text that preceded it. We listen on the worker bus's
// endListeners directly because `subscribe` only fires buffered events.
orchestrator.metaBus.endListeners.add(() => {
  flushPending();
  if (orchestrator.metaBus.endReason) {
    const envelope: BusEndEnvelope = orchestrator.metaBus.endReason;
    bridge.emit('bus.end', envelope);
  }
});

// ─── RPC handlers ───────────────────────────────────────────────
//
// We expose methods on the orchestrator (and its nested services) via
// a generic `rpc` request whose payload identifies the target. Main
// sends `{ path: ['kanban', 'createCard'], args: [...] }`; we look up
// `orchestrator.kanban.createCard` and invoke it. Returning a Promise
// just works — the bridge awaits it.
//
// This avoids hand-wiring each of the orchestrator's ~50 methods.
// The trade-off: typos on `path` only fail at runtime. Main-side
// callers should use a typed proxy that mirrors the orchestrator's
// public surface for compile-time safety.

interface RpcPayload {
  /** Property chain into the orchestrator, e.g. ['kanban', 'createCard']. */
  path: string[];
  /** Positional args. POJO-only — survived `structuredClone`. */
  args: unknown[];
}

bridge.handle('quality.setEnabled', (payload) => {
  const { enabled } = payload as { enabled: boolean };
  return qualityController.setEnabled(enabled);
});

bridge.handle('quality.status', () => ({ enabled: qualityController.isEnabled() }));

bridge.handle('rpc', async (payload) => {
  const { path, args } = payload as RpcPayload;
  if (!Array.isArray(path) || path.length === 0) {
    throw new Error('rpc: path must be a non-empty string array');
  }
  // Walk the property chain. `this` for the final call needs to be
  // the immediate owner so `kanban.createCard.call(orchestrator)`
  // doesn't lose service-private state.
  let target: unknown = orchestrator;
  for (let i = 0; i < path.length - 1; i++) {
    if (target == null || typeof target !== 'object') {
      throw new Error(`rpc: ${path.slice(0, i + 1).join('.')} is not an object`);
    }
    target = (target as Record<string, unknown>)[path[i]];
  }
  if (target == null || typeof target !== 'object') {
    throw new Error(`rpc: ${path.join('.')} parent is not an object`);
  }
  const methodName = path[path.length - 1];
  const fn = (target as Record<string, unknown>)[methodName];
  if (typeof fn !== 'function') {
    throw new Error(`rpc: ${path.join('.')} is not a function`);
  }
  const result = (fn as (...args: unknown[]) => unknown).apply(target, args);
  // Await if the method returned a promise; otherwise return as-is.
  return await Promise.resolve(result);
});

bridge.handle('orchestrator.property', (payload) => {
  // Cheap-read accessor for things like `companySessionId`, `parentSessionId`.
  const { name } = payload as { name: string };
  const value = (orchestrator as unknown as Record<string, unknown>)[name];
  // We can only structured-clone POJO values. The main-side proxy is
  // expected to only request primitives/POJOs through this handler.
  return value;
});

// ─── Supervisor RPC (Phase 3.1) ─────────────────────────────────
//
// Admin endpoints route through `bridge.request('supervisor.rpc', ...)`
// to call methods on the worker-local supervisor. Returns POJO results
// (already structured-clone-friendly). Supports:
//   - getStatus()
//   - listRecentIncidents(sessionId, limit)
//   - isRoleQuarantined(role)
//   - releaseRoleQuarantine(role)
//   - releaseReadOnlyMode()
//
// When `workerSupervisor` is null (env flag off), every call returns null.
type SupervisorRpcMethod =
  | 'getStatus'
  | 'listRecentIncidents'
  | 'isRoleQuarantined'
  | 'releaseRoleQuarantine'
  | 'releaseReadOnlyMode';

bridge.handle('supervisor.rpc', (payload) => {
  const { method, args } = payload as { method: SupervisorRpcMethod; args: unknown[] };
  if (!workerSupervisor) return null;
  switch (method) {
    case 'getStatus':
      return workerSupervisor.getStatus();
    case 'listRecentIncidents': {
      const [sessionId, limit] = args as [number, number?];
      return workerSupervisor.listRecentIncidents(sessionId, limit ?? 50);
    }
    case 'isRoleQuarantined':
      return workerSupervisor.isRoleQuarantined(args[0] as string);
    case 'releaseRoleQuarantine':
      return workerSupervisor.releaseRoleQuarantine(args[0] as string);
    case 'releaseReadOnlyMode':
      return workerSupervisor.releaseReadOnlyMode();
    default:
      throw new Error(`supervisor.rpc: unknown method ${String(method)}`);
  }
});

bridge.handle('stop', async () => {
  // Tear down the orchestrator. `abortAll` aborts any live runners
  // and marks the bus ended. The bus.end mirror above will fire.
  try {
    orchestrator.abortAll({ teardownSandbox: false, finalStatus: 'idle' });
  } catch (err) {
    console.warn(`[company-worker ${companySessionId}] abortAll threw:`, err);
  }
  // Drain the size-1 dbWriter (when MCP_DB_WORKER=1) so the in-flight final
  // turn-persist completes before this worker exits — same lost-final-turn
  // guard the main process applies in server.ts. No-op when the writer was
  // never created (flag off / no runCoder ran).
  try {
    await closeDbWriter();
  } catch (err) {
    console.warn(`[company-worker ${companySessionId}] closeDbWriter threw:`, err);
  }
  // Phase 1.6 — stop the supervisor's periodic tick + unsubscribe its
  // observation layer. Order matters: stop AFTER abortAll so terminal
  // events still flow through; but BEFORE busUnsubscribe so the
  // supervisor's lifecycle observers tear down cleanly.
  try {
    workerSupervisor?.stop();
    setGlobalAgentSupervisor(null);
  } catch (err) {
    console.warn(`[company-worker ${companySessionId}] supervisor stop threw:`, err);
  }
  // Phase 2.4 — close the persistence handle. The SQLite driver
  // is sync; this is a best-effort flush before process exit.
  try {
    if (workerSupervisionPersistence && 'close' in workerSupervisionPersistence) {
      (workerSupervisionPersistence as { close: () => void }).close();
    }
  } catch (err) {
    console.warn(
      `[company-worker ${companySessionId}] supervisor persistence close threw:`,
      err,
    );
  }
  flushPending();
  busUnsubscribe();
  try { companyStore.close(); } catch { /* best-effort */ }
  return { ok: true };
});

// Signal readiness so `WorkerHost.start()` resolves. After this the
// main thread is free to send RPCs.
bridge.emit('worker.ready', { companySessionId });

// Anchor `dbConn` so `noUnusedLocals` doesn't reject the declaration —
// the WAL handle must outlive the worker; nothing else references it.
void dbConn;
