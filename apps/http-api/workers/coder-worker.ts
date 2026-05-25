/**
 * Coder-session worker entrypoint (P17).
 *
 * One worker_thread per active `coder_sessions.id`. Mirrors the
 * company-worker design but for the simpler coder path (project
 * chat without the CompanyOrchestrator). Inside the worker:
 *
 *   1. Opens its own WAL SQLite handle via `openWorkerDb`.
 *   2. Boots `runCoder()` on demand (`runFresh` RPC) and holds the
 *      resulting `RunCoderHandle.runner` in module-scope state so
 *      subsequent RPCs (`pushUserMessage`, `isWaitingForInput`,
 *      `interruptWait`, …) can reach it without re-running.
 *   3. Subscribes to the run's bus and forwards every event to main
 *      via `bridge.emit('bus.event', { event, data, seq })`. Main
 *      mirrors them into a synthetic `CoderRunBus` so the existing
 *      `pumpBusToSSE` pipeline keeps working unchanged.
 *   4. Calls `wireRunnerToBus` against the worker-side bus — same
 *      module that lives in `routes/coder/state.ts`, lifted into a
 *      shared helper so both main and worker can wire identically.
 *
 * Notes:
 *   - Only the message-routing decision (is-waiting? interject?
 *     attach? fresh?) is hosted here; the main thread sends a single
 *     `sendUserMessage` RPC and the worker decides what to do
 *     internally. That collapses several round-trips into one.
 *   - On `stop`, we abort the run and exit. `DbConnection.close()`
 *     runs in the `exit` hook.
 */
// IMPORTANT: workers import via relative paths only. Node's loader
// resolves these before tsx/tsconfig `paths` get a chance, so an alias
// like `@mcp/orchestrator-host` throws "Cannot find package" inside a
// worker_thread. Relative paths resolve identically under tsx, tsc and
// raw node — see `apps/http-api/sse/workerKit.ts` for context.
import { parentPort, workerData } from 'node:worker_threads';
import {
  MessageBridge,
  openWorkerDb,
  type MessageBridgeOpts,
} from '../../../packages/orchestrator-host/src/index.js';
import {
  runCoder,
  type RunCoderHandle,
  type CoderAttachment,
} from '../../../packages/code-agent/src/index.js';
import type { CoderRunner } from '../../../packages/code-agent/src/core/runner.js';
import {
  setGlobalDocSearch,
  type DocSearchBackend,
} from '../../../packages/code-agent/src/tools/rag-search-docs.js';
import {
  setGlobalDocsResearcher,
  installDocsDeepResearch,
  type DocsResearchBridge,
} from '../../../packages/docs-agent/src/bridges/docs-bridge.js';
import type { DocsResearchResult } from '../../../packages/docs-agent/src/types.js';
import { createBus, publish, markEnded, setBusRunner, subscribe } from '../coder-bus.js';
import { wireRunnerEventsToBus } from '../sse/runnerWiring.js';
import { RemoteMcpServerManager } from './RemoteMcpServerManager.js';

interface CoderWorkerData {
  sessionId: number;
  dbPath: string;
}

const port = parentPort;
if (!port) throw new Error('coder-worker.ts: not running inside a worker_thread');

const { sessionId, dbPath } = workerData as CoderWorkerData;

const dbConn = openWorkerDb({ dbPath });

const bridge = new MessageBridge({
  port: port as unknown as MessageBridgeOpts['port'],
  onListenerError: (err, context) => {
    console.warn(`[coder-worker ${sessionId}] listener error in ${context}:`, err);
  },
});

// ─── Doc-corpus shim: route to the main process via RPC ──────────────
// `worker_threads` don't share module state, so the `setGlobalDocSearch`
// + `setGlobalDocsResearcher` singletons populated in server.ts on the
// main thread are NULL here. Without this shim, `rag_search_docs` from
// inside the worker would error with "doc corpus backend is not wired
// into this process". We install a thin proxy that forwards every
// `search` / `runResearch` call back to the main thread via
// `bridge.request`; the corresponding handlers live in
// `apps/http-api/sse/CoderWorkerPool.ts`. The actual `DocHybridSearch`
// + `DocsResearchBridge` instances live ONCE in the main process —
// zero duplication, single source of truth.
const docSearchShim: DocSearchBackend = {
  search: async (input) =>
    bridge.request<Awaited<ReturnType<DocSearchBackend['search']>>>(
      'docSearch',
      input,
      // 60s covers a worst-case rewrite+rerank round-trip on a slow
      // provider; the in-process path has no timeout at all but workers
      // need a ceiling to surface stuck-RPC bugs instead of hanging.
      { timeoutMs: 60_000 },
    ),
};
setGlobalDocSearch(docSearchShim);

// `DocsResearchBridge` is a CLASS in @mcp/docs-agent; here we only
// implement the `runResearch` method that `docs_deep_research` actually
// calls. The structural cast is honest — a deep-research run takes
// minutes (multi-turn LLM), hence the high timeout.
//
// NOTE on timeouts: this `timeoutMs` is the IPC-level ceiling on the
// `bridge.request` round-trip; it's a backstop against a stuck main-thread
// handler. The PRIMARY recovery barrier now lives on the runner side:
// `CoderRunner.invokeToolWithGuards` enforces a 30-minute per-tool timeout
// for `docs_deep_research` (explicit `tool.timeoutMs` on the definition)
// and emits a synthetic `tool_call_result` on expiry. So even if both this
// bridge AND the main-side handler hang, the runner unblocks at 30min and
// the session keeps going. See packages/code-agent/src/core/tool-timeouts.ts.
const docsResearcherShim = {
  runResearch: (input: Parameters<DocsResearchBridge['runResearch']>[0]): Promise<DocsResearchResult> =>
    bridge.request<DocsResearchResult>('docsResearch', input, { timeoutMs: 10 * 60_000 }),
} as unknown as DocsResearchBridge;
setGlobalDocsResearcher(docsResearcherShim);

// External-MCP proxy. Constructed once per worker; reuses the main
// process's `McpExternalPool` for every run inside this worker.
const remoteMcpManager = new RemoteMcpServerManager(bridge);

// Worker-local state for the active run. Re-set on every `runFresh`.
const ctrl = new AbortController();
const bus = createBus(ctrl);
let handle: RunCoderHandle | null = null;
let runner: CoderRunner | null = null;

// ─── Diagnostic state (Apêndice 4 Fase 1) ─────────────────────────
//
// When the worker dies mid-run, the `emitCrashToBus` log was previously
// just `{kind, message}` — useful but missing the breadcrumbs needed to
// localize the cause. We now record the last RPC name and the last bus
// event so the crash log carries the recent activity that probably
// triggered the throw. Gated by `MCP_CODER_WORKER_DEBUG=1` so prod
// logs stay terse.
const DEBUG = process.env.MCP_CODER_WORKER_DEBUG === '1';
let lastRpc: string | null = null;
let lastRpcAt = 0;
let lastBusEventName: string | null = null;
let lastBusEventAt = 0;
function recordRpc(name: string): void {
  lastRpc = name;
  lastRpcAt = Date.now();
}

// ─── Process-level safety net ─────────────────────────────────────
//
// Worker threads don't share the main process's `process.on(...)`
// handlers — installing them in `server.ts` has zero effect here. A
// stray throw inside a tool handler, a hook callback, or (most
// commonly) a provider stream's `for await` iterator would otherwise
// kill the worker silently: the parent's `CoderWorkerPool.onCrash`
// callback fires after `maxRestarts` exhaustion, but by then the
// `pumpBusToSSE` pipe has already lost the chance to flush a
// structured error to the dashboard. Result: the user sat on
// "Conectando…" forever even though the worker was dead.
//
// These handlers publish a final `error` event + `markEnded` so the
// SSE stream closes cleanly with a real reason before the process
// exits.
// ─── Crash classification (Apêndice 4 Fase 3) ─────────────────────
//
// The previous handler killed the worker on EVERY uncaughtException
// and let Node 22+ default-kill on EVERY unhandledRejection. That's
// safe but expensive: a transient provider stream hiccup (network
// blip, rate-limit retry-after, broken pipe on a backgrounded fetch)
// took out an active interactive session along with everything else.
//
// Classifier rules:
//   - "fatal" names always terminate (TypeError, ReferenceError, etc.)
//     — these signal a real bug, not a transient.
//   - "recoverable" names + message patterns are kept alive UNLESS
//     three of them land within a 60s window — at which point we
//     stop pretending it's transient and escalate to fatal.
//   - Unknown errors default to fatal (conservative). Opt out via
//     MCP_CODER_WORKER_STRICT_CRASH=1 if a class of error keeps
//     getting misclassified — that flag reverts to the old
//     always-fatal behaviour.
const STRICT_CRASH = process.env.MCP_CODER_WORKER_STRICT_CRASH === '1';
const RECOVERABLE_ERROR_NAMES = new Set([
  'AbortError',
  'TimeoutError',
  'FetchError',
  'NetworkError',
  'RequestError',
]);
const RECOVERABLE_MSG_PATTERN =
  /rate limit|stream interrupted|premature close|socket hang up|aborted|ECONNRESET|EPIPE|ETIMEDOUT|ENOTFOUND|EAI_AGAIN/i;
const FATAL_ERROR_NAMES = new Set([
  'TypeError',
  'ReferenceError',
  'SyntaxError',
  'RangeError',
  'AssertionError',
]);
type CrashClass = 'recoverable' | 'fatal';
function classifyCrash(err: unknown): CrashClass {
  if (STRICT_CRASH) return 'fatal';
  if (!(err instanceof Error)) return 'fatal';
  if (FATAL_ERROR_NAMES.has(err.name)) return 'fatal';
  if (RECOVERABLE_ERROR_NAMES.has(err.name)) return 'recoverable';
  if (RECOVERABLE_MSG_PATTERN.test(err.message)) return 'recoverable';
  return 'fatal';
}
let recentRecoverableTs: number[] = [];
function recordRecoverableAndCheckEscalation(): CrashClass {
  const now = Date.now();
  // Sliding window of 60s.
  recentRecoverableTs = recentRecoverableTs.filter((t) => now - t < 60_000);
  recentRecoverableTs.push(now);
  // 3rd recoverable in the window: stop forgiving — something is
  // genuinely broken, take the worker down so the dashboard sees a
  // terminal event instead of accumulating zombie state.
  return recentRecoverableTs.length > 3 ? 'fatal' : 'recoverable';
}

let exitingFromCrash = false;
function emitCrashToBus(prefix: string, message: string, err?: unknown): void {
  if (exitingFromCrash || bus.ended) return;
  exitingFromCrash = true;

  // Apêndice 4 Fase 1 — Structured crash diagnostics. Behind
  // `MCP_CODER_WORKER_DEBUG=1` so production logs stay terse but
  // operators can flip the flag, reproduce, and learn from a single
  // event WHAT was running when the worker died.
  if (DEBUG) {
    const now = Date.now();
    const errorName = err instanceof Error ? err.name : null;
    const stack = err instanceof Error ? err.stack : undefined;
    let runnerWaitingForInput: boolean | null = null;
    try { runnerWaitingForInput = runner?.isWaitingForInput?.() ?? null; } catch { /* ignore */ }
    console.error(
      `[coder-worker] crash ${JSON.stringify({
        sessionId,
        kind: prefix,
        errorName,
        message,
        stack,
        lastRpc,
        lastRpcAt,
        msSinceLastRpc: lastRpcAt ? now - lastRpcAt : null,
        lastBusEventName,
        lastBusEventAt,
        msSinceLastBusEvent: lastBusEventAt ? now - lastBusEventAt : null,
        runnerWaitingForInput,
        currentTurn: runner?.turn ?? null,
        busEnded: bus.ended,
      })}`,
    );
  }

  try {
    publish(bus, 'error', { message: `${prefix}: ${message}`, sessionId });
    markEnded(bus, 'error', {
      message: `${prefix}: ${message}`,
      reason: 'worker-uncaught',
      sessionId,
    });
  } catch (e) {
    console.error(`[coder-worker ${sessionId}] failed to flush crash event:`, e);
  }
}

process.on('uncaughtException', (err) => {
  const message = err instanceof Error ? err.message : String(err);
  const initialClass = classifyCrash(err);
  const finalClass =
    initialClass === 'recoverable' ? recordRecoverableAndCheckEscalation() : 'fatal';
  if (finalClass === 'recoverable') {
    console.warn(
      `[coder-worker ${sessionId}] uncaughtException (recoverable, keeping worker alive):`,
      err,
    );
    try {
      publish(bus, 'warning', {
        message: `recoverable uncaughtException: ${message}`,
        errorName: err instanceof Error ? err.name : 'unknown',
      });
    } catch { /* best-effort */ }
    return;
  }
  console.error(
    `[coder-worker ${sessionId}] uncaughtException (${initialClass === 'recoverable' ? 'escalated' : 'fatal'}):`,
    err,
  );
  emitCrashToBus('uncaughtException', message, err);
  // `setImmediate` lets the `bridge.emit('bus.end')` flush to the
  // parent thread BEFORE we exit; without it the parent never sees
  // the markEnded event and the dashboard hangs anyway.
  setImmediate(() => process.exit(1));
});

process.on('unhandledRejection', (reason) => {
  const message = reason instanceof Error ? reason.message : String(reason);
  const initialClass = classifyCrash(reason);
  const finalClass =
    initialClass === 'recoverable' ? recordRecoverableAndCheckEscalation() : 'fatal';
  if (finalClass === 'recoverable') {
    console.warn(
      `[coder-worker ${sessionId}] unhandledRejection (recoverable, keeping worker alive):`,
      reason,
    );
    try {
      publish(bus, 'warning', {
        message: `recoverable unhandledRejection: ${message}`,
        errorName: reason instanceof Error ? reason.name : 'unknown',
      });
    } catch { /* best-effort */ }
    return;
  }
  console.error(
    `[coder-worker ${sessionId}] unhandledRejection (${initialClass === 'recoverable' ? 'escalated' : 'fatal'}):`,
    reason,
  );
  emitCrashToBus('unhandledRejection', message, reason);
  // Don't force exit — Node 22+ default kills the process anyway,
  // but the markEnded above guarantees the parent sees the terminal
  // event before the process dies.
});

// Forward every bus event to main. `since: -1` replays the buffer so
// events emitted during runCoder() spin-up don't get lost.
subscribe(
  bus,
  (ev) => {
    // Apêndice 4 Fase 1 — breadcrumb for crash diagnostics. The
    // crash log includes "ms since last bus event" which is the
    // fastest way to spot a worker dying mid-stream vs idle.
    lastBusEventName = ev.event;
    lastBusEventAt = Date.now();
    bridge.emit('bus.event', { seq: ev.seq, event: ev.event, data: ev.data });
  },
  -1,
);

bus.endListeners.add(() => {
  if (bus.endReason) {
    bridge.emit('bus.end', bus.endReason);
  }
});

// ─── RPC handlers ───────────────────────────────────────────────

interface RunFreshPayload {
  userMessage: string;
  attachments?: CoderAttachment[];
  maxTurns?: number;
  planMode?: boolean;
  agent?: 'explore' | 'plan' | 'build' | 'admin';
  profile?: 'bootstrap' | 'navigate' | 'full' | 'auto';
  worktree?: { name?: string; branch?: string };
  thinking?: boolean;
  deepThink?: boolean;
  deepThinkModel?: string;
  deepThinkProvider?: string;
  preThinkOnToolResults?: boolean;
  selectedSkillIds?: string[];
  /**
   * Apêndice 4 Fase 2 — propagate `resume:true` to `runCoder` so the
   * worker can pick up from history when the previous worker died
   * mid-wait. Last DB message must be `role:'tool'`; the route handler
   * appended the synthetic tool_result before calling runFresh, so the
   * invariant holds.
   */
  resume?: boolean;
}

bridge.handle('runFresh', async (payload) => {
  recordRpc('runFresh');
  const opts = payload as RunFreshPayload;
  if (handle) throw new Error('coder-worker: run already in progress');
  try {
    const result = await runCoder({
      session: { id: sessionId },
      userMessage: opts.userMessage,
      attachments: opts.attachments,
      maxTurns: opts.maxTurns,
      planMode: opts.planMode,
      agent: opts.agent,
      profile: opts.profile,
      worktree: opts.worktree,
      thinking: opts.thinking,
      deepThink: opts.deepThink,
      deepThinkModel: opts.deepThinkModel,
      deepThinkProvider: opts.deepThinkProvider,
      preThinkOnToolResults: opts.preThinkOnToolResults,
      selectedSkillIds: opts.selectedSkillIds,
      resume: opts.resume,
      signal: ctrl.signal,
      onSnapshotRecorded: (info) => publish(bus, 'session_snapshot_changed', info),
      // Mirror the in-process wiring in routes/coder/stream.ts so the
      // docs_deep_research tool appears on turn 1 of every worker-thread
      // run too. Pulls the singleton we installed above; if neither
      // shim nor real bridge is set the helper returns false and the
      // tool just doesn't appear.
      onRunnerReady: (innerRunner) => {
        installDocsDeepResearch(innerRunner);
      },
      // RemoteMcpServerManager fronts the main-process McpExternalPool
      // so we don't redial every external MCP server per session boot.
      // The pool serializes a snapshot once per worker; tool invocations
      // round-trip through `mcpExt.callTool`. When the http-api wasn't
      // wired with a pool (legacy / tests), the snapshot comes back
      // empty and runCoder falls through its "no external tools" path.
      externalMcpManager: remoteMcpManager,
    } as Parameters<typeof runCoder>[0]);
    handle = result;
    runner = result.runner;
    setBusRunner(bus, result.runner);
    publish(bus, 'session', result.session);
    publish(bus, 'index_status', result.indexStatus);
    wireRunnerEventsToBus(result.runner, bus);

    // Fire the runner's lifecycle awaiter in the background so the
    // RPC returns quickly — caller doesn't want to wait for the
    // whole turn.
    void result.done
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        publish(bus, 'error', { message });
        markEnded(bus, 'error', { message });
      })
      .finally(() => {
        // Linger the bus state so a late reconnect sees buffered events.
        // The main side's pool handles eviction TTL — we just keep the
        // worker alive until it's killed.
        runner = null;
      });

    return { ok: true, session: result.session, indexStatus: result.indexStatus };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    publish(bus, 'error', { message });
    markEnded(bus, 'error', { message });
    throw err;
  }
});

bridge.handle('isWaitingForInput', () => {
  recordRpc('isWaitingForInput');
  if (!runner) return false;
  return runner.isWaitingForInput();
});

bridge.handle('interruptWait', () => {
  recordRpc('interruptWait');
  if (!runner) return { ok: false, reason: 'no_runner' };
  try {
    runner.interruptWait();
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
});

bridge.handle('pushUserMessage', (payload) => {
  recordRpc('pushUserMessage');
  const { content, selectedSkillIds } = payload as {
    content: string;
    selectedSkillIds?: string[];
  };
  if (!runner) throw new Error('coder-worker: no runner — call runFresh first');
  runner.pushUserMessage(content, { selectedSkillIds });
  return { ok: true };
});

/**
 * Resume a tool blocked on `waitForUserInput()` (submit_plan,
 * submit_tasks, ask_user). The route handler calls this when the
 * dashboard's review UI fires; the tool's promise resolves with
 * `value` and the runner proceeds with its tool_result. Without
 * this RPC the runner would stay blocked forever and the dashboard
 * would fall back to writing the result directly to the DB, which
 * leaves the in-flight tool dangling and pollutes session state.
 */
bridge.handle('provideUserInput', (payload) => {
  recordRpc('provideUserInput');
  const { value } = payload as { value: string };
  if (!runner) return { ok: false, reason: 'no_runner' };
  const accepted = runner.provideUserInput(value);
  return { ok: accepted };
});

bridge.handle('setThinking', (payload) => {
  recordRpc('setThinking');
  const { thinking } = payload as { thinking: boolean };
  if (!runner) return { ok: false, reason: 'no_runner' };
  runner.setThinking(thinking);
  return { ok: true };
});

bridge.handle('setDeepThink', (payload) => {
  recordRpc('setDeepThink');
  const { deepThink, model, provider } = payload as {
    deepThink: boolean;
    model?: string;
    provider?: string;
  };
  if (!runner) return { ok: false, reason: 'no_runner' };
  runner.setDeepThink(deepThink, { model, provider });
  return { ok: true };
});

bridge.handle('abort', () => {
  recordRpc('abort');
  try {
    ctrl.abort();
    if (runner) {
      try { runner.abort(); } catch { /* best-effort */ }
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
});

bridge.handle('stop', async () => {
  recordRpc('stop');
  try {
    ctrl.abort();
    if (runner) {
      try { runner.abort(); } catch { /* best-effort */ }
    }
  } catch { /* best-effort */ }
  return { ok: true };
});

bridge.emit('worker.ready', { sessionId });

void dbConn;
