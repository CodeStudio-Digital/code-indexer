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
}

export const BUFFER_CAP = 2000;

export function createBus(ctrl: AbortController): CoderRunBus {
  return {
    ctrl,
    buffer: [],
    nextSeq: 0,
    subscribers: new Set(),
    ended: false,
  };
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
export function waitEnded(bus: CoderRunBus, signal?: AbortSignal, pollMs = 200): Promise<void> {
  return new Promise<void>((resolve) => {
    if (bus.ended || signal?.aborted) return resolve();
    const t = setInterval(() => {
      if (bus.ended || signal?.aborted) { clearInterval(t); resolve(); }
    }, pollMs);
    signal?.addEventListener('abort', () => { clearInterval(t); resolve(); }, { once: true });
  });
}
