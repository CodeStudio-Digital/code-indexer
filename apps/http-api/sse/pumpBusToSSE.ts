import type { Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import {
  attachReplayTrimEnabled,
  buildAttachReplay,
  subscribe,
  subscribeWithReplay,
  waitEnded,
  type BufferedEvent,
  type CoderRunBus,
} from '../coder-bus.js';
import { attachHeartbeat } from './SSEHeartbeat.js';

export interface PumpBusToSSEOptions {
  /** Last-Event-ID equivalent for replay. `-1` means no replay. */
  since?: number;
  /** Whether to attach the periodic heartbeat. Defaults to `true`. */
  heartbeat?: boolean;
  /**
   * Perf W2 — trim the `since=-1` replay to cross-turn state + the live tail
   * (see `buildAttachReplay`). Coder streams opt in; company streams keep the
   * full replay (their event kinds are not covered by the coder trim list).
   * Cursor reconnects (`since >= 0`) are never trimmed.
   */
  trimReplay?: boolean;
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
  // Anti-buffering: Hono's streamSSE already sets Content-Type/Cache-Control/
  // Connection, but proxies (nginx, Vite dev http-proxy, Cloudflare) key off
  // `X-Accel-Buffering: no` to flush SSE frames immediately instead of
  // delivering tokens in bursts. Set here once so every pump consumer
  // (coder attach/messages, company, projects) is covered — same precedent
  // as docs-agent/index.ts and docs/index.ts (`markUnbuffered`).
  c.header('X-Accel-Buffering', 'no');
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

    // Perf W2 — trimmed attach replay: the route opts in AND the env flag
    // must be on (default OFF — see attachReplayTrimEnabled). Computed up
    // front so the bus_info preamble reports the actual first replay seq.
    const trimmedReplay: readonly BufferedEvent[] | null =
      opts.trimReplay && attachReplayTrimEnabled() && since < 0
        ? buildAttachReplay(bus)
        : null;

    // Transport-level preamble: tells the client which bus instance this
    // connection serves, so it can pair (busId, seq) for dedup across
    // replays/zombie streams. Enqueued BEFORE subscribe so it precedes the
    // replay in the drain chain. Deliberately has NO `id` — a non-numeric or
    // reused id would corrupt the client's Last-Event-ID cursor. Never
    // publish()ed: it must not enter the buffer, consume a seq, or reach the
    // JSONL sink.
    enqueueWrite({
      event: 'bus_info',
      data: JSON.stringify({
        bus_id: bus.busId,
        first_replay_seq: trimmedReplay
          ? (trimmedReplay[0]?.seq ?? bus.nextSeq)
          : (bus.buffer[0]?.seq ?? bus.nextSeq),
        dropped_replay_events: bus.droppedBufferEvents ?? 0,
      }),
    });

    const onEvent = (ev: BufferedEvent): void => {
      enqueueWrite({
        id: String(ev.seq),
        event: ev.event,
        data: JSON.stringify(ev.data),
      });
    };
    const unsubscribe = trimmedReplay
      ? subscribeWithReplay(bus, onEvent, trimmedReplay)
      : subscribe(bus, onEvent, since);
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
