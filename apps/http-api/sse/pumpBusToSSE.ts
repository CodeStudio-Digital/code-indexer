import type { HttpContext } from '@mcp/shared/http/router.js';
import { streamSSE } from '@mcp/shared/http/sse.js';
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
import {
  SerializedWriteQueue,
  streamDrainTimeoutMs,
  streamQueueLimits,
} from './SerializedWriteQueue.js';

const LAST_EVENT_BUS_ID_HEADER = 'X-MCP-Bus-ID';

interface PumpBusToSSEOptions {
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
 * Shared SSE pump — pipes a CoderRunBus into the HttpRouter stream. Extracted to
 * eliminate duplication that previously lived in company/stream.ts,
 * coder/stream.ts, and projects.ts.
 *
 * Heartbeat is ON by default. Pass `heartbeat: false` to opt out (e.g., for
 * short-lived streams where the client is expected to disconnect promptly).
 */
export function pumpBusToSSE(
  c: HttpContext,
  bus: CoderRunBus,
  opts: PumpBusToSSEOptions = {},
) {
  const rawSince = Number.isFinite(opts.since ?? NaN)
    ? (opts.since as number)
    : parseLastEventId(c);
  const requestedBusId = parseLastEventBusId(c);
  const since = effectiveSinceForBus(
    rawSince,
    bus.nextSeq,
    requestedBusId,
    bus.busId,
  );
  const heartbeat = opts.heartbeat ?? true;
  // Anti-buffering: HttpRouter's streamSSE already sets Content-Type/Cache-Control/
  // Connection, but proxies (nginx, Vite dev http-proxy, Cloudflare) key off
  // `X-Accel-Buffering: no` to flush SSE frames immediately instead of
  // delivering tokens in bursts. Set here once so every pump consumer
  // (coder attach/messages, company, projects) is covered — same precedent
  // as docs-agent/index.ts and docs/index.ts (`markUnbuffered`).
  c.header('X-Accel-Buffering', 'no');
  return streamSSE(c, async (stream) => {
    const ac = new AbortController();
    const limits = streamQueueLimits();
    const writer = new SerializedWriteQueue(
      (msg: { id?: string; event?: string; data: string }) => stream.writeSSE(msg),
      {
        ...limits,
        signal: ac.signal,
        // Overflow only disconnects this subscriber. The run and its bounded
        // replay bus continue, so ReconnectingSSEClient can resume with the
        // last event id it actually consumed.
        onOverflow: (error) => {
          console.warn(
            `[sse] disconnecting slow consumer bus=${bus.busId} `
            + `pending=${error.pendingWrites} bytes=${error.pendingBytes}`,
          );
          ac.abort();
        },
        onWriteError: () => ac.abort(),
      },
    );
    stream.onAbort(() => {
      ac.abort();
      writer.stop();
    });

    // Heartbeats use this exact writer too. They can no longer race a token
    // frame or terminal event through a second write path.
    const queuedWriter = {
      writeSSE: (msg: { id?: string; event?: string; data: string }) =>
        writer.enqueue(msg, estimateSSEMessageBytes(msg)),
    };
    const stopHeartbeat = heartbeat ? attachHeartbeat(queuedWriter) : () => {};

    const enqueueWrite = (msg: { id?: string; event: string; data: string }): void => {
      // Queue errors are converted into subscriber aborts by the callbacks
      // above. Every returned promise still gets a rejection handler.
      void queuedWriter.writeSSE(msg).catch(() => undefined);
    };

    // Bounded semantic attach replay: coder routes opt in. Retired environment
    // switches do not expand cursorless replay. Compute before bus_info so
    // the preamble reports the actual first replay seq.
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

    let terminalEnqueued = false;
    const onEvent = (ev: BufferedEvent): void => {
      if (ev.event === 'done' || ev.event === 'error') terminalEnqueued = true;
      enqueueWrite({
        id: String(ev.seq),
        event: ev.event,
        data: serializeSSEData(ev.data),
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
      // `markEnded()` records the terminal outcome but deliberately does not
      // publish a bus row. Some producers publish done/error first, others do
      // not, and an old terminal row may already have fallen out of replay.
      // Every connection therefore guarantees one explicit terminal frame.
      if (!ac.signal.aborted && bus.endReason && !terminalEnqueued) {
        terminalEnqueued = true;
        enqueueWrite({
          event: bus.endReason.event,
          data: serializeSSEData(bus.endReason.data),
        });
      }
      if (!ac.signal.aborted) {
        const drained = await writer.waitForIdle(streamDrainTimeoutMs());
        if (!drained) {
          console.warn(`[sse] terminal drain timed out bus=${bus.busId}`);
          ac.abort();
        }
      }
      writer.stop();
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

/**
 * A numeric cursor is meaningful only inside the bus that allocated it.
 * New clients pair Last-Event-ID with X-MCP-Bus-ID; missing bus ids retain
 * the legacy range heuristic for backward compatibility.
 */
export function effectiveSinceForBus(
  since: number,
  nextSeq: number,
  requestedBusId: string | null,
  currentBusId: string,
): number {
  if (requestedBusId && requestedBusId !== currentBusId) return -1;
  return effectiveSince(since, nextSeq);
}

/** Parse the standard `Last-Event-ID` header (returns -1 when absent/invalid). */
export function parseLastEventId(c: HttpContext): number {
  const header = c.req.header('Last-Event-ID');
  if (!header) return -1;
  const n = parseInt(header, 10);
  return Number.isFinite(n) ? n : -1;
}

function parseLastEventBusId(c: HttpContext): string | null {
  const header = c.req.header(LAST_EVENT_BUS_ID_HEADER)?.trim();
  return header && header.length <= 256 ? header : null;
}

function estimateSSEMessageBytes(msg: { id?: string; event?: string; data: string }): number {
  return Buffer.byteLength(msg.data, 'utf8')
    + Buffer.byteLength(msg.event ?? '', 'utf8')
    + Buffer.byteLength(msg.id ?? '', 'utf8')
    + 32;
}

function serializeSSEData(data: unknown): string {
  const serialized = JSON.stringify(data);
  return serialized === undefined ? '{}' : serialized;
}
