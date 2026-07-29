import { createEventHandlers } from './handlers.js';
import type { SessionId, StreamBlock, UpdateSession } from './types.js';
import { ZERO_DELTA } from './types.js';
import { ReconnectingSSEClient } from '@mcp/shared/sse/ReconnectingSSEClient.js';
import type { SSEEvent } from '@mcp/shared/sse/SSEFramer.js';
import { apiBaseUrl } from '../../lib/api-client.js';
import { noteWorkerLogBus, pushWorkerLog } from './worker-log-store.js';
import { isAlreadyAppliedDelta } from './stream-seq-dedup.js';
import { buildLogEntry, createWorkerLogCapturePolicy } from './worker-log-policy.js';
import type { NotificationSourceContext } from '../../features/notifications/index.js';

/**
 * Events processed per drain batch before yielding the main thread back to
 * the renderer. A reattach can replay the server's whole ring buffer (up to
 * ~2000 events / 8MB) in one burst; ~50 per batch keeps each batch well
 * under a frame budget while a full replay costs only ~40 yields.
 */
const EVENT_BATCH_SIZE = 50;

/**
 * Yield the renderer main thread between drain batches. Prefers
 * `scheduler.yield()` (Chromium 129+ — resumes at continuation priority,
 * ahead of other queued tasks) and falls back to a 0ms macrotask.
 */
function yieldToEventLoop(): Promise<void> {
  const sched = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler;
  return sched?.yield ? sched.yield() : new Promise((resolve) => setTimeout(resolve, 0));
}

export interface OpenStreamOpts {
  url: string;
  method: 'POST' | 'GET';
  body?: Record<string, unknown>;
  lastEventId?: number;
  /** Bus instance paired with `lastEventId`; a seq is unsafe without it. */
  lastEventBusId?: string;
  reattach?: boolean;
  /** Existing blocks already covered by `lastEventId`. Cursor reattach must
   *  continue from these instead of rebuilding an impossible partial turn. */
  initialBlocks?: StreamBlock[];
}

export interface OpenStreamDeps {
  updateSession: UpdateSession;
  abortMap: Map<SessionId, AbortController>;
  notificationContext?: NotificationSourceContext;
  /**
   * Persisted highest SSE id per sid, used as Last-Event-ID on reattach.
   * Kept in a ref-backed Map (not React state) because it advances on every
   * single event — writing it to `SessionState` would re-render the chat
   * 50+/s for a value nothing renders.
   */
  lastSeenSeqMap: Map<SessionId, number>;
  /** Bus instance paired with each persisted sequence cursor. */
  lastSeenBusIdMap: Map<SessionId, string>;
}

/**
 * Open an SSE stream for a coder session and pump events into the per-sid
 * state slot. Used by sendMessage (POST /messages), the plan/question resume
 * path (POST /continue) AND reattach (GET /attach with Last-Event-ID) so
 * every entry point shares the same live rendering pipeline.
 *
 * Transport concerns (SSE framing, Last-Event-ID, reconnect, heartbeat) are
 * delegated to the shared ReconnectingSSEClient — this function only wires
 * the event pipeline into the session state slot.
 */
export async function openStream(
  sid: SessionId,
  opts: OpenStreamOpts,
  deps: OpenStreamDeps,
  onMessageComplete?: () => void,
): Promise<void> {
  const { updateSession, abortMap, lastSeenSeqMap } = deps;

  const blocks: StreamBlock[] = opts.initialBlocks ? [...opts.initialBlocks] : [];
  const toolIndex = new Map<string, number>();
  for (let index = 0; index < blocks.length; index++) {
    const block = blocks[index];
    if (block.type === 'tool') toolIndex.set(block.call.id, index);
  }

  updateSession(sid, {
    streaming: true,
    currentTurn: { blocks: [...blocks] },
    doneReason: null,
    error: null,
    runDelta: ZERO_DELTA,
    reattached: !!opts.reattach,
    // Stale approvals can't be resolved across runs — the wait slots died
    // with the previous run (interruptWait/abort already denied them).
    pendingApprovals: [],
  });
  // If a previous stream for this sid is still alive (rapid session switch /
  // resubmit), abort it before installing the new controller — otherwise the
  // old fetch keeps pumping bytes into a detached pipeline.
  abortMap.get(sid)?.abort();
  const ctrl = new AbortController();
  abortMap.set(sid, ctrl);

  // A numeric sequence is scoped to one bus. Never send an unpaired cursor:
  // a new run restarts seq at zero and may already be beyond the old value.
  let lastSeenBusId = typeof opts.lastEventBusId === 'string' && opts.lastEventBusId
    ? opts.lastEventBusId
    : null;
  let lastSeenSeq = lastSeenBusId
    && typeof opts.lastEventId === 'number'
    && opts.lastEventId >= 0
    ? opts.lastEventId
    : -1;
  // Throttle the `lastEventAt` commit (stall detector only needs ~1s).
  // Transport heartbeats use this same path but never enter the event queue,
  // transcript, worker log, or replay cursor.
  let lastEventAtCommit = Number.NEGATIVE_INFINITY;
  const commitLiveness = (receivedAt: number): void => {
    // A superseded reader can finish parsing a chunk after abort. It must not
    // refresh the replacement stream's liveness slot.
    if (ctrl.signal.aborted || abortMap.get(sid) !== ctrl) return;
    if (receivedAt - lastEventAtCommit < 1000) return;
    lastEventAtCommit = receivedAt;
    updateSession(sid, { lastEventAt: receivedAt });
  };
  const shouldCaptureWorkerLog = createWorkerLogCapturePolicy();
  // Clear the "Analyzing the task…" (preflight) indicator once the run actually
  // starts streaming — the first event means preflight finished and the model
  // is now producing output.
  let preflightCleared = false;

  // Batch flushes to at most one per animation frame. Tokens arrive at
  // 50+/s; without batching every token triggers a full React re-render of
  // the persisted history. rAF collapses bursts into a single commit.
  let flushHandle: number | null = null;
  let flushTimeout: ReturnType<typeof setTimeout> | null = null;
  const doFlush = () => updateSession(sid, { currentTurn: { blocks: [...blocks] } });
  const flush = () => {
    if (flushHandle !== null) return;
    flushHandle = requestAnimationFrame(() => {
      flushHandle = null;
      if (flushTimeout !== null) { clearTimeout(flushTimeout); flushTimeout = null; }
      doFlush();
    });
    // Fallback: rAF is throttled/suspended in background tabs or on machines
    // where the browser suspends the rendering pipeline (no GPU, power-saving
    // mode). The timeout guarantees the flush still happens in those cases.
    flushTimeout = setTimeout(() => {
      flushTimeout = null;
      if (flushHandle !== null) {
        cancelAnimationFrame(flushHandle);
        flushHandle = null;
        doFlush();
      }
    }, 50);
  };
  // Provider/terminal events (message_complete/done/error) call flushNow to
  // guarantee the boundary state is committed synchronously. The block buffer
  // itself spans the complete run and is reconciled with persisted history.
  const flushNow = () => {
    if (flushHandle !== null) { cancelAnimationFrame(flushHandle); flushHandle = null; }
    if (flushTimeout !== null) { clearTimeout(flushTimeout); flushTimeout = null; }
    doFlush();
  };
  doFlush();

  const handlers = createEventHandlers({
    sid,
    blocks,
    toolIndex,
    flush,
    flushNow,
    updateSession,
    onMessageComplete,
  });

  // In Electron the relative `/api/...` URL would route through the Vite
  // dev proxy, which has been observed to swallow SSE flushes even with
  // x-accel-buffering disabled. Prefixing with the absolute Hono URL
  // (localhost:7333 when MCP_DEV_HTTP=1) makes the chat reliable. In
  // browser dev the prefix is empty so the proxy still handles things.
  const absoluteUrl = opts.url.startsWith('http')
    ? opts.url
    : `${apiBaseUrl()}${opts.url}`;

  // Stamp a stable idempotency key on POST bodies. ReconnectingSSEClient
  // reuses this same object across backoff retries, so the key is identical on
  // every retry — the server dedupes a re-POST into a bus replay instead of
  // re-running the send's side effects (duplicate user message / run). GET
  // (/attach) is naturally idempotent and left untouched.
  if (opts.method === 'POST') {
    const b = (opts.body ??= {});
    if (typeof b.client_msg_id !== 'string') {
      b.client_msg_id =
        globalThis.crypto?.randomUUID?.() ??
        `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    }
  }

  // Process ONE event through the session pipeline. Called only from the
  // drain loop below, strictly in arrival order — never straight from the
  // transport.
  const processEvent = (ev: SSEEvent): void => {
    // Transport-level preamble sent once per (re)connection, before any
    // replay: identifies the bus instance so the worker-log store can
    // dedup by (busId, seq). Never logged and never fed to handlers.
    // It flows through the same queue as data events ON PURPOSE — resetting
    // the (busKey, hwm) mark out of order would poison the dedup for events
    // of the previous bus still awaiting drain.
    if (ev.event === 'bus_info') {
      try {
        const info = JSON.parse(ev.data || '{}') as {
          bus_id?: string;
          first_replay_seq?: number;
          dropped_replay_events?: number;
        };
        if (info.bus_id) {
          if (info.bus_id !== lastSeenBusId) {
            // The server already compared the request's X-MCP-Bus-ID and
            // full-replayed this new bus. Reset locally before its seq 0 is
            // processed; future reconnects now carry the new pair.
            lastSeenSeq = -1;
            lastSeenSeqMap.delete(sid);
          }
          lastSeenBusId = info.bus_id;
          deps.lastSeenBusIdMap.set(sid, info.bus_id);
          noteWorkerLogBus(sid, info.bus_id);
        }
        // Replay-gap visibility: the pump reports how many buffered events
        // were evicted before this attach. When our cursor is older than
        // the retained window, those events are permanently lost to the
        // live view — surface it instead of silently accepting
        // non-contiguous seqs. Completed turns are safe (persisted in the
        // DB transcript); in-flight deltas reconcile at message_complete.
        const dropped = typeof info.dropped_replay_events === 'number'
          ? info.dropped_replay_events
          : 0;
        if (dropped > 0) {
          const firstReplay = typeof info.first_replay_seq === 'number' ? info.first_replay_seq : null;
          const gapOverlap = lastSeenSeq >= 0 && firstReplay !== null && firstReplay > lastSeenSeq + 1;
          pushWorkerLog(sid, {
            ts: Date.now(),
            event: 'replay_gap',
            level: gapOverlap ? 'warn' : 'info',
            category: 'lifecycle',
            message: gapOverlap
              ? `Replay gap: ${dropped} buffered events were evicted ahead of your cursor (first retained seq ${firstReplay}, cursor at ${lastSeenSeq}). The live view may have missed events; completed turns stay intact via the persisted transcript.`
              : `Replay buffer evicted ${dropped} events before this attach (fresh replay from seq ${firstReplay ?? 'unknown'}).`,
            data: info,
          });
        }
      } catch { /* malformed preamble — ignore */ }
      return;
    }
    // Persist the highest id for reattach in a ref (no re-render). The
    // cursor marks only FULLY-HANDLED events: it is committed after the
    // handler runs, so a handler crash leaves the cursor behind and the
    // next reconnect replays the event instead of losing it. Payload-less
    // and unparseable events commit immediately — they carry no handler
    // state, and re-dropping them on every reconnect would be a poison
    // pill. (React state for the cursor was a hidden 50+/s churn source;
    // it stays in a ref.)
    const commitCursor = () => {
      if (ev.id !== undefined && ev.id > lastSeenSeq) {
        lastSeenSeq = ev.id;
        lastSeenSeqMap.set(sid, ev.id);
      }
    };
    if (!ev.data) { commitCursor(); return; }
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(ev.data);
    } catch {
      console.warn('[agent-stream] dropping malformed event payload', { event: ev.event, id: ev.id });
      commitCursor();
      return;
    }
    // Capture diagnostic events before dispatch, but do not duplicate raw
    // token deltas and sample repeated progress heartbeats. Semantic events
    // such as lifecycle/tool boundaries, errors and changed progress notes
    // remain lossless. The chat handlers below still receive every event.
    const receivedAt = Date.now();
    if (shouldCaptureWorkerLog(ev.event, data, receivedAt)) {
      const entry = buildLogEntry(ev.event, data);
      pushWorkerLog(sid, entry, ev.id);
    }
    // Stall detector (StuckBanner) only needs ~1s granularity — throttle
    // the lastEventAt commit so it isn't a per-event re-render of AgentChat.
    commitLiveness(receivedAt);
    if (!preflightCleared) {
      preflightCleared = true;
      updateSession(sid, { preflight: null });
    }
    // A replay re-delivers deltas already folded into `blocks`; re-applying one
    // duplicates its content in place. See stream-seq-dedup.ts.
    if (isAlreadyAppliedDelta(ev.event, ev.id, lastSeenSeq)) {
      commitCursor();
      return;
    }
    const handler = handlers[ev.event];
    if (handler) handler(data, ev.event);
    commitCursor();
  };

  // Chunked event pump. A reattach replay bursts the whole ring buffer into
  // the SSE read loop in one tick; running processEvent synchronously per
  // event froze the renderer main thread for the entire replay (the rAF
  // batching above only coalesces the final setState, not the per-event
  // JSON.parse + handler work). Events are therefore ALWAYS enqueued and
  // drained in ordered batches, yielding the event loop between batches. A
  // single FIFO queue + `draining` flag keeps STRICT arrival order even when
  // new events land while a drain is suspended in a yield. The live path
  // (1–2 events per tick) merely defers by one macrotask — invisible next to
  // the rAF-coalesced flush.
  const eventQueue: SSEEvent[] = [];
  let draining = false;
  let drainDone: Promise<void> = Promise.resolve();

  const drainEventQueue = async (): Promise<void> => {
    draining = true;
    try {
      do {
        // Yield BEFORE each batch: the SSE framer delivers a parsed chunk's
        // events in one synchronous loop, so deferring lets the whole burst
        // accumulate instead of "batching" one event at a time.
        await yieldToEventLoop();
        if (ctrl.signal.aborted) {
          // Unmounted / superseded (see abortMap): the pipeline is dead —
          // discard pending events instead of pumping a detached session.
          eventQueue.length = 0;
          return;
        }
        for (const ev of eventQueue.splice(0, EVENT_BATCH_SIZE)) processEvent(ev);
      } while (eventQueue.length > 0);
    } finally {
      draining = false;
    }
  };

  const client = new ReconnectingSSEClient({
    url: absoluteUrl,
    method: opts.method,
    body: opts.body,
    signal: ctrl.signal,
    getLastEventId: () => lastSeenSeq,
    getLastEventBusId: () => lastSeenBusId,
    // Never reconnect over a stale cursor: `lastSeenSeq` advances at
    // processing time, so a retry racing an in-flight drain would ask the
    // server to replay events still sitting in the queue (double delivery
    // into the handlers). The backoff sleep normally outlasts the drain;
    // awaiting it here makes that a guarantee.
    onReconnect: async () => { await drainDone; },
    onEvent: (ev) => {
      eventQueue.push(ev);
      if (!draining) drainDone = drainEventQueue();
    },
    onHeartbeat: commitLiveness,
    isTerminal: (ev) => ev.event === 'done' || ev.event === 'error',
  });

  try {
    try {
      await client.run();
    } finally {
      // The transport resolves on the RAW terminal frame (isTerminal above),
      // which may still be sitting in the queue. Drain — or, when aborted,
      // discard — before the error handling / teardown below so handler-side
      // state (doneReason, final flushNow) lands first, exactly as it did
      // when the pipeline was synchronous.
      if (ctrl.signal.aborted) eventQueue.length = 0;
      await drainDone;
    }
  } catch (e) {
    if ((e as Error).name !== 'AbortError') {
      // Special case: server returned 409 INTERACTION_PENDING because the
      // runner was blocked inside an interactive tool. Surface as a
      // structured handshake state instead of a raw error so the UI can
      // render an explicit "interrupt and resend" choice.
      const err = e as { status?: number; httpBody?: { code?: string; error?: string } };
      if (err.status === 409 && err.httpBody?.code === 'INTERACTION_PENDING') {
        const pendingContent =
          (opts.body && typeof (opts.body as { content?: unknown }).content === 'string')
            ? ((opts.body as { content: string }).content)
            : '';
        updateSession(sid, {
          interactionPending: {
            code: err.httpBody.code,
            message: err.httpBody.error ?? 'Runner is waiting for an interactive answer.',
            pendingContent,
          },
        });
      } else if (err.status === 404 && opts.reattach) {
        // /attach 404 collapses three states into one HTTP status:
        // "session never had a run", "worker died silently", "run
        // completed and the bus was evicted". The /state endpoint
        // disambiguates so the UI shows a useful message instead of
        // a generic "HTTP 404: no active run".
        const stateUrl = absoluteUrl.replace(/\/attach(?:\?.*)?$/, '/state');
        try {
          const res = await fetch(stateUrl);
          if (res.ok) {
            const body = (await res.json()) as {
              status?: string;
              alive?: boolean;
            };
            if (body.alive === false && (body.status === 'in_progress' || body.status === 'running' || body.status === 'working')) {
              // Worker died mid-run, session row is still stale.
              updateSession(sid, {
                error: 'Session was interrupted by a server / worker crash. Send a new message to resume.',
              });
            } else {
              // status=idle/completed/terminal → the run actually finished or
              // never started. A process-owned live turn may have survived the
              // React surface that originally consumed it; once the bus is
              // gone it can no longer contribute new events and must not be
              // resurrected as a duplicate on every remount.
              lastSeenSeqMap.delete(sid);
              deps.lastSeenBusIdMap.delete(sid);
              updateSession(sid, { error: null, currentTurn: null });
              onMessageComplete?.();
            }
          } else {
            updateSession(sid, { error: 'No active run on this session.' });
          }
        } catch {
          updateSession(sid, { error: 'No active run on this session.' });
        }
      } else {
        let msg: string;
        if (e instanceof Error) {
          const status = (e as { status?: number }).status;
          const httpBody = (e as { httpBody?: { error?: { message?: string }; message?: string } }).httpBody;
          const body = httpBody?.error?.message ?? httpBody?.message;
          msg = body
            ? (status ? `HTTP ${status}: ${body}` : body)
            : e.message;
        } else {
          msg = String(e);
        }
        updateSession(sid, { error: msg });
      }
    }
  } finally {
    if (flushHandle !== null) { cancelAnimationFrame(flushHandle); flushHandle = null; }
    if (flushTimeout !== null) { clearTimeout(flushTimeout); flushTimeout = null; }
    // Only tear down if we're STILL the active controller — a newer openStream
    // for this sid may have already replaced us (rapid resubmit / session
    // switch). Clobbering the live slot's `streaming` / `preflight` here would
    // hide the replacement run's "Analyzing the task…" indicator + spinner while
    // it's still mid-preflight. A superseded stream's teardown is a no-op.
    if (abortMap.get(sid) === ctrl) {
      // Clear streaming + the preflight indicator (safety net for an error
      // before any event arrived — the per-event clear above handles the happy path).
      updateSession(sid, { streaming: false, preflight: null });
      abortMap.delete(sid);
    }
  }
}
