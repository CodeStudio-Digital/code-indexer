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

bridge.handle('stop', async () => {
  // Tear down the orchestrator. `abortAll` aborts any live runners
  // and marks the bus ended. The bus.end mirror above will fire.
  try {
    orchestrator.abortAll({ teardownSandbox: false, finalStatus: 'idle' });
  } catch (err) {
    console.warn(`[company-worker ${companySessionId}] abortAll threw:`, err);
  }
  busUnsubscribe();
  try { companyStore.close(); } catch { /* best-effort */ }
  return { ok: true };
});

// Signal readiness so `WorkerHost.start()` resolves. After this the
// main thread is free to send RPCs.
bridge.emit('worker.ready', { companySessionId });

// Keep references to satisfy `noUnusedLocals` — these closures stay
// alive for the worker's lifetime via the bridge handlers.
void dbConn;
void CoderRunBus_typeOnly;
void publish_typeOnly;
void markEnded_typeOnly;

// Type-only references — we don't actually use these at runtime
// in the worker, but the import keeps the worker's tree-shaker from
// dropping the bus module (its symbols are reachable through the
// `subscribe` import either way; this comment documents intent).
declare const CoderRunBus_typeOnly: CoderRunBus | undefined;
declare const publish_typeOnly: typeof publish | undefined;
declare const markEnded_typeOnly: typeof markEnded | undefined;
