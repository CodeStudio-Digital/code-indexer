import { randomUUID } from 'node:crypto';
import type { CoderRunner } from '@mcp/code-agent/core/runner.js';

/**
 * Per-session event bus with replay buffer for the coder SSE pipeline.
 *
 * Decouples the lifetime of a coder run from any individual HTTP client:
 *   - The run is started and wired to a bus inside POST /messages or
 *     POST /continue, but the HTTP response only *subscribes* to the bus.
 *   - If the client disconnects (tab closed), the run keeps producing events
 *     into the buffer.
 *   - GET /sessions/:id/attach lets the same (or another) client re-subscribe
 *     and replay missed events via the Last-Event-ID header (or from seq -1).
 *
 * The buffer is bounded by both row count and approximate retained bytes;
 * older events are dropped once either cap is exceeded. That's fine because
 * persisted assistant/tool messages are already in the DB — only the *live*
 * view (text deltas + in-progress tool calls) relies on the buffer.
 */

export interface BufferedEvent {
  seq: number;
  event: string;
  data: unknown;
}

export type BusSubscriber = (ev: BufferedEvent) => void;

export interface CoderRunBus {
  ctrl: AbortController;
  runner?: CoderRunner;
  /**
   * Unique id of this bus instance. The bus is recreated per run and `seq`
   * restarts at 0 with it, so seq alone cannot deduplicate across runs —
   * clients pair this id with seq (see the `bus_info` SSE preamble).
   */
  busId: string;
  buffer: BufferedEvent[];
  /**
   * Approximate retained size of `buffer`. Optional for compatibility with
   * lightweight test/company bus facades that predate the byte budget.
   */
  bufferBytes?: number;
  /** Per-row estimates kept parallel to `buffer` so eviction never re-walks payloads. */
  bufferEventBytes?: number[];
  /** Number of replay rows evicted by either the count or byte budget. */
  droppedBufferEvents?: number;
  nextSeq: number;
  subscribers: Set<BusSubscriber>;
  ended: boolean;
  endReason?: { event: 'done' | 'error'; data: unknown };
  endListeners: Set<() => void>;
  eventSinks: Set<(ev: BufferedEvent) => void>;
  /**
   * Resolves once `runner` has been attached via `setBusRunner`. Lets callers
   * that need to push messages mid-run (the enqueue-and-attach branch of
   * POST /messages) wait out the brief async setup window between
   * `createBus` and `bus.runner = handle.runner`.
   */
  runnerReady: Promise<CoderRunner>;
  /** Internal — resolves `runnerReady`. Set by `createBus`. */
  _resolveRunner: (r: CoderRunner) => void;
  /** Internal — rejects `runnerReady` if the run never produces a runner. */
  _rejectRunner: (err: unknown) => void;
}

export const BUFFER_CAP = 2000;
/**
 * A count-only ring can still retain hundreds of MB when tool results contain
 * large patches/JSON. Keep replay bounded by bytes as well as rows. Live
 * subscribers still receive every event; only the reconnect replay is pruned.
 */
export const BUFFER_BYTE_CAP = 8 * 1024 * 1024;

const SIZE_WALK_NODE_CAP = 10_000;

/**
 * Cheap, cycle-safe retained-size estimate. Strings and binary payloads carry
 * the exact byte cost; structured payloads are walked only up to a hard node
 * cap, at which point we conservatively treat the row as oversized. This
 * avoids JSON.stringify in the token-stream hot path.
 */
function estimateReplayBytes(value: unknown): number {
  const stack: unknown[] = [value];
  const seen = new Set<object>();
  let bytes = 32;
  let nodes = 0;

  while (stack.length > 0) {
    if (++nodes > SIZE_WALK_NODE_CAP) return BUFFER_BYTE_CAP + 1;
    const current = stack.pop();
    if (current == null) {
      bytes += 4;
    } else if (typeof current === 'string') {
      bytes += Buffer.byteLength(current, 'utf8');
    } else if (typeof current === 'number' || typeof current === 'bigint') {
      bytes += 8;
    } else if (typeof current === 'boolean') {
      bytes += 4;
    } else if (typeof current === 'object') {
      if (seen.has(current)) continue;
      seen.add(current);
      if (current instanceof ArrayBuffer) {
        bytes += current.byteLength;
      } else if (ArrayBuffer.isView(current)) {
        bytes += current.byteLength;
      } else if (Array.isArray(current)) {
        bytes += current.length * 8;
        for (const item of current) stack.push(item);
      } else {
        for (const [key, item] of Object.entries(current)) {
          bytes += Buffer.byteLength(key, 'utf8') + 8;
          stack.push(item);
        }
      }
    }
    if (bytes > BUFFER_BYTE_CAP) return bytes;
  }
  return bytes;
}

function ensureBufferAccounting(bus: CoderRunBus): void {
  if (bus.bufferEventBytes && typeof bus.bufferBytes === 'number') return;
  bus.bufferEventBytes = bus.buffer.map((event) => estimateReplayBytes(event.event) + estimateReplayBytes(event.data));
  bus.bufferBytes = bus.bufferEventBytes.reduce((sum, size) => sum + size, 0);
  bus.droppedBufferEvents ??= 0;
}

export function clearReplayBuffer(bus: CoderRunBus): void {
  bus.buffer.length = 0;
  bus.bufferEventBytes = [];
  bus.bufferBytes = 0;
}

export function createBus(ctrl: AbortController): CoderRunBus {
  let resolveRunner!: (r: CoderRunner) => void;
  let rejectRunner!: (err: unknown) => void;
  const runnerReady = new Promise<CoderRunner>((res, rej) => {
    resolveRunner = res;
    rejectRunner = rej;
  });
  // Swallow unhandled rejections — callers that never await `runnerReady`
  // shouldn't crash the process if `_rejectRunner` is invoked on an early
  // `runCoder` failure.
  runnerReady.catch(() => { /* intentional */ });
  return {
    ctrl,
    busId: randomUUID(),
    buffer: [],
    bufferBytes: 0,
    bufferEventBytes: [],
    droppedBufferEvents: 0,
    nextSeq: 0,
    subscribers: new Set(),
    ended: false,
    endListeners: new Set(),
    eventSinks: new Set(),
    runnerReady,
    _resolveRunner: resolveRunner,
    _rejectRunner: rejectRunner,
  };
}

/**
 * Attach a CoderRunner to the bus. Resolves the `runnerReady` promise so
 * concurrent POST /messages handlers waiting for the runner can proceed.
 * Idempotent: subsequent calls are no-ops.
 */
export function setBusRunner(bus: CoderRunBus, runner: CoderRunner): void {
  if (bus.runner) return;
  bus.runner = runner;
  bus._resolveRunner(runner);
}

export function publish(bus: CoderRunBus, event: string, data: unknown): BufferedEvent {
  const ev: BufferedEvent = { seq: bus.nextSeq++, event, data };
  ensureBufferAccounting(bus);
  const eventBytes = estimateReplayBytes(event) + estimateReplayBytes(data);
  bus.buffer.push(ev);
  bus.bufferEventBytes!.push(eventBytes);
  bus.bufferBytes = (bus.bufferBytes ?? 0) + eventBytes;
  // Find the eviction prefix first, then compact each parallel array once.
  // Repeated Array.shift() turns one oversized tool result after a full ring
  // into O(BUFFER_CAP²) element moves on the event-loop hot path.
  let removeCount = 0;
  let removedBytes = 0;
  const retainedBytes = bus.bufferBytes;
  while (
    removeCount < bus.buffer.length
    && (
      bus.buffer.length - removeCount > BUFFER_CAP
      || retainedBytes - removedBytes > BUFFER_BYTE_CAP
    )
  ) {
    removedBytes += bus.bufferEventBytes![removeCount] ?? 0;
    removeCount += 1;
  }
  if (removeCount > 0) {
    bus.buffer.splice(0, removeCount);
    bus.bufferEventBytes!.splice(0, removeCount);
    bus.bufferBytes = Math.max(0, retainedBytes - removedBytes);
    bus.droppedBufferEvents = (bus.droppedBufferEvents ?? 0) + removeCount;
  }
  for (const sub of bus.subscribers) {
    try { sub(ev); } catch { /* ignore subscriber errors */ }
  }
  for (const sink of bus.eventSinks) {
    try { sink(ev); } catch { /* ignore sink errors */ }
  }
  return ev;
}

export function addBusEventSink(bus: CoderRunBus, sink: (ev: BufferedEvent) => void): () => void {
  bus.eventSinks.add(sink);
  return () => { bus.eventSinks.delete(sink); };
}

/**
 * Structured logging shorthand for the dashboard's WorkerLogPanel.
 *
 * Emits a `worker_log` event carrying `{ts, level, category, message,
 * data?}`. The dashboard captures every event into `SessionState.eventLog`,
 * but `worker_log` carries the explicit headline + level + bucket so
 * cross-cutting concerns (route hits, pool spawns, hook fires) show up
 * with sensible defaults instead of being inferred from an event name.
 *
 * No-ops silently when `bus` is null/undefined so callers can opt in
 * without guarding every site (`emitWorkerLog(pool.getBus(id), ...)` is
 * the common pattern and `getBus` returns null when no run is active).
 */
export interface WorkerLogPayload {
  ts: number;
  level: 'info' | 'warn' | 'error' | 'debug';
  category:
    | 'route'
    | 'pool'
    | 'worker'
    | 'runner'
    | 'tool'
    | 'provider'
    | 'lifecycle'
    | 'message'
    | 'other';
  message: string;
  data?: unknown;
}

export function emitWorkerLog(
  bus: CoderRunBus | null | undefined,
  level: WorkerLogPayload['level'],
  category: WorkerLogPayload['category'],
  message: string,
  data?: unknown,
): void {
  if (!bus || bus.ended) return;
  publish(bus, 'worker_log', {
    ts: Date.now(),
    level,
    category,
    message,
    ...(data !== undefined ? { data } : {}),
  } satisfies WorkerLogPayload);
}

export function markEnded(bus: CoderRunBus, event: 'done' | 'error', data: unknown) {
  bus.ended = true;
  bus.endReason = { event, data };
  // If `runnerReady` was never resolved (the run failed before `setBusRunner`
  // could fire), reject it now so any waiter unblocks instead of hanging.
  if (!bus.runner) {
    bus._rejectRunner(new Error('run ended before runner was attached'));
  }
  for (const fn of bus.endListeners) {
    try { fn(); } catch { /* ignore */ }
  }
  bus.endListeners.clear();
}

/**
 * Subscribe to the bus. Immediately replays every buffered event with
 * seq > sinceSeq, then forwards live events until unsubscribed.
 * Returns an unsubscribe function.
 *
 * Race-free ordering: the subscriber is registered BEFORE the replay runs,
 * with live events that arrive during the replay queued and flushed right
 * after it. Previously the replay ran first and the subscriber was added
 * after, so a (reentrant) publish during the replay loop was never
 * delivered — and a reentrant publish that triggered buffer eviction could
 * also shift the live array mid-iteration and skip events. Dedup is by
 * seq: publish() assigns monotonically increasing seqs, so anything live
 * during the replay has seq > maxReplaySeq.
 */
export function subscribe(
  bus: CoderRunBus,
  sub: BusSubscriber,
  sinceSeq = -1,
): () => void {
  // Snapshot first — the live buffer must not be mutated under our feet by
  // a reentrant publish (eviction splices the head, growth appends).
  const replay = bus.buffer.filter((ev) => ev.seq > sinceSeq);
  const maxReplaySeq = replay.length > 0 ? replay[replay.length - 1]!.seq : sinceSeq;
  let replaying = true;
  const queued: BufferedEvent[] = [];
  const wrapped: BusSubscriber = (ev) => {
    if (replaying) {
      if (ev.seq > maxReplaySeq) queued.push(ev);
      return;
    }
    sub(ev);
  };
  bus.subscribers.add(wrapped);
  for (const ev of replay) {
    try { sub(ev); } catch { /* ignore */ }
  }
  // Drain with replay mode still ON and an index-based loop: a reentrant
  // publish while handling an early queued event is appended to `queued`
  // and drained in sequence (strict seq order), instead of being delivered
  // immediately ahead of the older queued events.
  for (let i = 0; i < queued.length; i++) {
    try { sub(queued[i]!); } catch { /* ignore */ }
  }
  replaying = false;
  return () => { bus.subscribers.delete(wrapped); };
}

/**
 * Perf W2 — attach-replay trim. A remount attach (`since=-1`) used to replay
 * the ENTIRE ring (up to BUFFER_CAP=2000 events / 8MB) in one burst, which
 * the renderer parses synchronously — a major part of the open-session
 * freeze. The persisted transcript already covers finished turns, so the
 * attach replay only needs (a) the LIVE tail — everything from the last
 * `message_complete` on, which is what reconstructs `currentTurn` — plus
 * (b) the low-volume CROSS-TURN state kinds below (task runs, spawned-agent
 * groups, pipelines, interactive gates) that the dashboard accumulates from
 * events across turns. The replay weight lives in the turn-local kinds
 * (text/thinking deltas, tool_call_*), which are exactly what gets dropped.
 *
 * Reconnects with a cursor (`since >= 0`) NEVER trim — the client's
 * (busId, hwm) dedup depends on the contiguous cursor replay.
 */
export const REPLAY_STATE_KINDS = new Set<string>([
  // TRANSCRIPT-bearing kinds (incident 2026-07-20: dropping these erased the
  // live run's completed turns from the UI — the client rebuilds turns it
  // hasn't refetched from these events, not only from the GET). The real
  // volume is in text/thinking deltas + worker_log, which stay excluded.
  'message_complete', 'tool_call_start', 'tool_call_result',
  'goal_mutations_persisted', 'goal_mutations_persistence_failed', 'provider_call',
  // Interactive gates / cards that may still be pending from an older turn.
  'tool_approval_request', 'tool_approval_resolved',
  'plan', 'spec', 'question', 'decision',
  // Task board + execute_tasks runs span many turns.
  'tasks_posted', 'task_started', 'task_finished', 'task_updated',
  'task_run_started', 'task_run_task_started', 'task_run_task_progress',
  'task_run_task_finished', 'task_run_finished',
  // Spawned-agent groups (background jobs) span turns.
  'agents_group_start', 'agent_progress', 'agents_group_end',
  // Pipeline lifecycle spans turns.
  'pipeline_started', 'pipeline_node_started', 'pipeline_node_completed',
  'pipeline_node_failed', 'pipeline_paused', 'pipeline_resumed',
  'pipeline_completed', 'pipeline_aborted', 'pipeline_failed',
  // Latest-wins session state the client has no other live source for.
  'todos_updated', 'session_agent_changed', 'session_drive_changed',
  'session_snapshot_changed', 'diagram_changed', 'context_status',
  'index_status', 'auto_continue',
  // Long-running operation markers (started/finished only — progress ticks
  // re-emit within seconds and would dominate the window).
  'operation_started', 'operation_finished',
]);

export const DEFAULT_ATTACH_REPLAY_MAX_EVENTS = 600;

/** Hard safety cap for reconstructible cross-turn state (most-recent wins). */
export function attachReplayCap(): number {
  const n = Number.parseInt(process.env.CODER_ATTACH_REPLAY_MAX_EVENTS ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_ATTACH_REPLAY_MAX_EVENTS;
}

/**
 * Bounded semantic replay is the safe default for coder attaches. The original
 * opt-in implementation dropped transcript-bearing kinds; buildAttachReplay
 * now retains those kinds plus the complete live tail. Keep an explicit
 * emergency compatibility switch (`CODER_ATTACH_REPLAY_TRIM=0`) without
 * making every cursorless remount pay for the whole 2,000-row ring.
 */
export function attachReplayTrimEnabled(): boolean {
  return process.env.CODER_ATTACH_REPLAY_TRIM !== '0';
}

/**
 * The trimmed `since=-1` replay window: cross-turn state kinds from the whole
 * buffer + everything from the last `message_complete` (inclusive — it may
 * not have hit the DB yet when the client GETs the transcript), in strict
 * buffer order. Only the reconstructible cross-turn prefix is capped. The
 * live tail is already bounded by the bus ring and must remain complete:
 * dropping its beginning creates an assistant/tool pair that exists in
 * neither the persisted transcript nor the replay.
 */
export function buildAttachReplay(bus: CoderRunBus): BufferedEvent[] {
  let boundary = 0;
  for (let i = bus.buffer.length - 1; i >= 0; i--) {
    if (bus.buffer[i].event === 'message_complete') { boundary = i; break; }
  }
  const prefix: BufferedEvent[] = [];
  for (let i = 0; i < boundary; i++) {
    const ev = bus.buffer[i];
    if (REPLAY_STATE_KINDS.has(ev.event)) prefix.push(ev);
  }
  const cap = attachReplayCap();
  const boundedPrefix = prefix.length > cap ? prefix.slice(-cap) : prefix;
  return [...boundedPrefix, ...bus.buffer.slice(boundary)];
}

/**
 * Replay a precomputed event window, then subscribe live. Used by the SSE
 * pump's trimmed attach path; `subscribe` keeps the full-replay contract for
 * every other caller (worker forwarding, company streams, tests).
 *
 * Same race-free ordering as `subscribe`: the live subscription is
 * registered before the replay, and live events published during the
 * replay (seq > last replayed seq) are queued and flushed right after it
 * instead of being lost.
 */
export function subscribeWithReplay(
  bus: CoderRunBus,
  sub: BusSubscriber,
  replay: readonly BufferedEvent[],
): () => void {
  const maxReplaySeq = replay.length > 0 ? replay[replay.length - 1]!.seq : -1;
  let replaying = true;
  const queued: BufferedEvent[] = [];
  const wrapped: BusSubscriber = (ev) => {
    if (replaying) {
      if (ev.seq > maxReplaySeq) queued.push(ev);
      return;
    }
    sub(ev);
  };
  bus.subscribers.add(wrapped);
  for (const ev of replay) {
    try { sub(ev); } catch { /* ignore */ }
  }
  // Same ordering guarantee as `subscribe`: replay mode stays on while the
  // queue drains, so reentrant publishes append and flush in seq order.
  for (let i = 0; i < queued.length; i++) {
    try { sub(queued[i]!); } catch { /* ignore */ }
  }
  replaying = false;
  return () => { bus.subscribers.delete(wrapped); };
}

/**
 * Wait until the bus is marked ended or the optional signal fires (e.g. SSE
 * client disconnected). Resolves in both cases so the caller's finally block
 * always runs and can clean up subscriptions / schedule orchestrator eviction.
 */
export function waitEnded(bus: CoderRunBus, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (bus.ended || signal?.aborted) return resolve();
    let settled = false;
    const settle = () => {
      if (!settled) { settled = true; bus.endListeners.delete(onEnd); resolve(); }
    };
    const onEnd = settle;
    bus.endListeners.add(onEnd);
    signal?.addEventListener('abort', settle, { once: true });
  });
}
