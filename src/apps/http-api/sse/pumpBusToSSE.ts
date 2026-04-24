import type { Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import {
  subscribe,
  waitEnded,
  type CoderRunBus,
} from '../coder-bus.js';
import { attachHeartbeat } from './SSEHeartbeat.js';

export interface PumpBusToSSEOptions {
  /** Last-Event-ID equivalent for replay. `-1` means no replay. */
  since?: number;
  /** Whether to attach the periodic heartbeat. Defaults to `true`. */
  heartbeat?: boolean;
  /** Called in the finally block after the stream closes. */
  onDone?: () => void;
}

/**
 * Shared SSE pump — pipes a CoderRunBus into the Hono stream. Extracted to
 * eliminate duplication that previously lived in company/stream.ts,
 * coder/stream.ts, and projects.ts.
 *
 * Heartbeat is ON by default. Pass `heartbeat: false` to opt out (e.g., for
 * short-lived streams where the client is expected to disconnect promptly).
 */
export function pumpBusToSSE(
  c: Context,
  bus: CoderRunBus,
  opts: PumpBusToSSEOptions = {},
) {
  const since = Number.isFinite(opts.since ?? NaN) ? (opts.since as number) : -1;
  const heartbeat = opts.heartbeat ?? true;
  return streamSSE(c, async (stream) => {
    const ac = new AbortController();
    stream.onAbort(() => ac.abort());

    const stopHeartbeat = heartbeat ? attachHeartbeat(stream) : () => {};
    const unsubscribe = subscribe(
      bus,
      (ev) => {
        void stream.writeSSE({
          id: String(ev.seq),
          event: ev.event,
          data: JSON.stringify(ev.data),
        });
      },
      since,
    );
    try {
      await waitEnded(bus, ac.signal);
    } finally {
      unsubscribe();
      stopHeartbeat();
      await stream.close();
      opts.onDone?.();
    }
  });
}

/** Parse the standard `Last-Event-ID` header (returns -1 when absent/invalid). */
export function parseLastEventId(c: Context): number {
  const header = c.req.header('Last-Event-ID');
  if (!header) return -1;
  const n = parseInt(header, 10);
  return Number.isFinite(n) ? n : -1;
}
