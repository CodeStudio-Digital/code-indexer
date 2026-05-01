import type { CoderRunner } from '../../core/coder/core/runner.js';

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
 * The buffer is a fixed-capacity ring; older events are dropped once the cap
 * is exceeded. That's fine because persisted assistant/tool messages are
 * already in the DB — only the *live* view (text deltas + in-progress tool
 * calls) relies on the buffer.
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
  buffer: BufferedEvent[];
  nextSeq: number;
  subscribers: Set<BusSubscriber>;
  ended: boolean;
  endReason?: { event: 'done' | 'error'; data: unknown };
  endListeners: Set<() => void>;
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
    buffer: [],
    nextSeq: 0,
    subscribers: new Set(),
    ended: false,
    endListeners: new Set(),
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
  bus.buffer.push(ev);
  if (bus.buffer.length > BUFFER_CAP) bus.buffer.shift();
  for (const sub of bus.subscribers) {
    try { sub(ev); } catch { /* ignore subscriber errors */ }
  }
  return ev;
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
 */
export function subscribe(
  bus: CoderRunBus,
  sub: BusSubscriber,
  sinceSeq = -1,
): () => void {
  for (const ev of bus.buffer) {
    if (ev.seq > sinceSeq) {
      try { sub(ev); } catch { /* ignore */ }
    }
  }
  bus.subscribers.add(sub);
  return () => { bus.subscribers.delete(sub); };
}

/**
 * Wait until the bus is marked ended or the optional signal fires (e.g. SSE
 * client disconnected). Resolves in both cases so the caller's finally block
 * always runs and can clean up subscriptions / schedule orchestrator eviction.
 */
export function waitEnded(bus: CoderRunBus, signal?: AbortSignal, _pollMs = 200): Promise<void> {
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
