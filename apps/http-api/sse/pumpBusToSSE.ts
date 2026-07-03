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
  const rawSince = Number.isFinite(opts.since ?? NaN) ? (opts.since as number) : -1;
  const since = effectiveSince(rawSince, bus.nextSeq);
  const heartbeat = opts.heartbeat ?? true;
  return streamSSE(c, async (stream) => {
    const ac = new AbortController();
    stream.onAbort(() => ac.abort());

    const stopHeartbeat = heartbeat ? attachHeartbeat(stream) : () => {};

    // Sequential write queue — writes are awaited in order so backpressure
    // is respected. A write failure means the client disconnected; abort
    // immediately so waitEnded resolves and stream.close() doesn't hang.
    let drainChain = Promise.resolve();
    const enqueueWrite = (msg: { id?: string; event: string; data: string }) => {
      drainChain = drainChain.then(() => {
        if (ac.signal.aborted) return;
        return stream.writeSSE(msg).catch(() => { ac.abort(); });
      });
    };

    // Transport-level preamble: tells the client which bus instance this
    // connection serves, so it can pair (busId, seq) for dedup across
    // replays/zombie streams. Enqueued BEFORE subscribe so it precedes the
    // replay in the drain chain. Deliberately has NO `id` — a non-numeric or
    // reused id would corrupt the client's Last-Event-ID cursor. Never
    // publish()ed: it must not enter the buffer, consume a seq, or reach the
    // JSONL sink.
    enqueueWrite({ event: 'bus_info', data: JSON.stringify({ bus_id: bus.busId }) });

    const unsubscribe = subscribe(
      bus,
      (ev) => {
        enqueueWrite({
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
      if (!ac.signal.aborted) await drainChain;
      await stream.close();
      opts.onDone?.();
    }
  });
}

/**
 * Clamp a replay cursor against the bus it will be applied to. A cursor at or
 * beyond `nextSeq` cannot have come from this bus (seq restarts at 0 per bus)
 * — it is a stale Last-Event-ID from a previous run's bus, so fall back to a
 * full replay instead of silently skipping everything.
 */
export function effectiveSince(since: number, nextSeq: number): number {
  return since >= nextSeq ? -1 : since;
}

/** Parse the standard `Last-Event-ID` header (returns -1 when absent/invalid). */
export function parseLastEventId(c: Context): number {
  const header = c.req.header('Last-Event-ID');
  if (!header) return -1;
  const n = parseInt(header, 10);
  return Number.isFinite(n) ? n : -1;
}
