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
import {
  MessageBridge,
  openWorkerDb,
  type MessageBridgeOpts,
} from '../../../packages/orchestrator-host/src/index.js';
import { CompanyStore } from '../../../packages/store/src/company-store.js';
import { CodeIndexDB } from '../../../packages/store/src/db.js';
import { CompanyOrchestrator } from '../../../packages/company/src/orchestrator.js';
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
// NOTE: `docs_deep_research` additionally needs a per-runner
// `installDocsDeepResearch(runner)` call (it's not a always-registered
// bootstrap tool like `rag_search_docs`). That lives in the company
// runner path (spawn.ts / start.ts) and is a separate follow-up — until
// then this singleton is wired but the tool won't surface for
// subordinates. `rag_search_docs` works the moment this shim is set.
const docSearchShim: DocSearchBackend = {
  search: async (input) =>
    bridge.request<Awaited<ReturnType<DocSearchBackend['search']>>>(
      'docSearch',
      input,
      { timeoutMs: 60_000 },
    ),
};
setGlobalDocSearch(docSearchShim);

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

// Build the stores. Both wrap better-sqlite3 internally — we let
// them open their own handles to keep the construction unchanged.
// `CodeIndexDB` and `CompanyStore` are both safe to instantiate
// from a worker thread.
const companyStore = new CompanyStore(dbPath);
const db = new CodeIndexDB(dbPath);

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
    workerSupervisionPersistence = new SqliteSupervisionPersistence(dbPath);
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
    },
    subordinates: {
      // Async signature on the public method; preserve it through.
      resume: (agentRunId, message) => orchestrator.resumeSubordinate(agentRunId, message),
      abort: (agentRunId) => Promise.resolve(orchestrator.abortSubordinate(agentRunId)),
    },
    // `runners` map is intentionally absent — Phase 2.3 will plumb
    // per-agent runner references through SubordinateLifecycle so
    // abortStuckTool can inject tool_result errors. Until then,
    // STUCK_TOOL recovery downgrades to the abort path (still
    // unwedges the run, just terminates it).
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
const busUnsubscribe = subscribe(
  orchestrator.metaBus,
  (ev) => {
    const envelope: BusEventEnvelope = { seq: ev.seq, event: ev.event, data: ev.data };
    bridge.emit('bus.event', envelope);
  },
  -1,
);

// Mirror the terminal event so the main-side bus also resolves
// `waitEnded`. We listen on the worker bus's endListeners directly
// because `subscribe` only fires buffered events, not the end.
orchestrator.metaBus.endListeners.add(() => {
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
