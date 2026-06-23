import { createEventHandlers } from './handlers.js';
import type { StreamBlock, UpdateSession, WorkerLogEntry } from './types.js';
import { ZERO_DELTA } from './types.js';
import { ReconnectingSSEClient } from '@mcp/shared/sse/ReconnectingSSEClient.js';
import { apiBaseUrl } from '../../lib/api-client.js';
import { pushWorkerLog } from './worker-log-store.js';
import { notifyCoderStreamEvent, type NotificationSourceContext } from '../../features/notifications/index.js';

/**
 * Derive `{level, category, message}` for the worker-log entry from the
 * raw SSE event name + payload. Most events flow through this fallback;
 * the `worker_log` event itself carries those fields explicitly and is
 * special-cased.
 */
function buildLogEntry(eventName: string, data: Record<string, unknown>): WorkerLogEntry {
  if (eventName === 'worker_log') {
    const w = data as {
      ts?: number;
      level?: WorkerLogEntry['level'];
      category?: WorkerLogEntry['category'];
      message?: string;
    };
    return {
      ts: typeof w.ts === 'number' ? w.ts : Date.now(),
      event: 'worker_log',
      level: w.level ?? 'info',
      category: w.category ?? 'other',
      message: w.message ?? '(no message)',
      data,
    };
  }
  // Coarse mapping: keep this table tiny — categories are for filtering,
  // not for forensics. The full event name stays in `event` for power users.
  let category: WorkerLogEntry['category'] = 'other';
  let level: WorkerLogEntry['level'] = 'info';
  if (eventName.startsWith('tool_') || eventName.startsWith('task_run_')) category = 'tool';
  else if (eventName.startsWith('operation_') || eventName === 'bt_state_dwell') category = 'runner';
  else if (eventName.startsWith('quality_') || eventName === 'tool_loop_intervention')
    category = 'quality';
  else if (
    eventName === 'provider_call' ||
    eventName === 'provider_swapped' ||
    eventName === 'fallback_activated'
  )
    category = 'provider';
  else if (
    eventName === 'turn_start' ||
    eventName === 'message_complete' ||
    eventName === 'history_compacted' ||
    eventName === 'auto_continue'
  )
    category = 'lifecycle';
  else if (eventName === 'text' || eventName === 'thinking') category = 'message';
  else if (eventName === 'run_started' || eventName === 'done') category = 'runner';
  if (eventName === 'error') level = 'error';
  else if (eventName === 'warning' || eventName === 'tool_loop_intervention') level = 'warn';
  return {
    ts: Date.now(),
    event: eventName,
    level,
    category,
    message: eventName,
    data,
  };
}

export interface OpenStreamOpts {
  url: string;
  method: 'POST' | 'GET';
  body?: Record<string, unknown>;
  lastEventId?: number;
  reattach?: boolean;
}

export interface OpenStreamDeps {
  updateSession: UpdateSession;
  abortMap: Map<number, AbortController>;
  notificationContext?: NotificationSourceContext;
  /**
   * Persisted highest SSE id per sid, used as Last-Event-ID on reattach.
   * Kept in a ref-backed Map (not React state) because it advances on every
   * single event — writing it to `SessionState` would re-render the chat
   * 50+/s for a value nothing renders.
   */
  lastSeenSeqMap: Map<number, number>;
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
  sid: number,
  opts: OpenStreamOpts,
  deps: OpenStreamDeps,
  onMessageComplete?: () => void,
): Promise<void> {
  const { updateSession, abortMap, lastSeenSeqMap, notificationContext } = deps;

  updateSession(sid, {
    streaming: true,
    currentTurn: { blocks: [] },
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

  const blocks: StreamBlock[] = [];
  const toolIndex = new Map<string, number>();

  // Track the most recent SSE id so reconnects resume from the right point.
  let lastSeenSeq = typeof opts.lastEventId === 'number' && opts.lastEventId >= 0
    ? opts.lastEventId
    : -1;
  // Throttle the `lastEventAt` commit (stall detector only needs ~1s).
  let lastEventAtCommit = 0;
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
  // Terminal events (message_complete/done/error) call flushNow to guarantee
  // the final state is committed synchronously before the buffer is cleared.
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

  const client = new ReconnectingSSEClient({
    url: absoluteUrl,
    method: opts.method,
    body: opts.body,
    signal: ctrl.signal,
    getLastEventId: () => lastSeenSeq,
    onEvent: (ev) => {
      // Persist the highest id for reattach in a ref (no re-render). This
      // fires on every event; writing it to React state was a hidden 50+/s
      // churn source even though nothing renders the value.
      if (ev.id !== undefined && ev.id > lastSeenSeq) {
        lastSeenSeq = ev.id;
        lastSeenSeqMap.set(sid, ev.id);
      }
      if (!ev.data) return;
      let data: Record<string, unknown>;
      try {
        data = JSON.parse(ev.data);
      } catch {
        return;
      }
      notifyCoderStreamEvent(sid, ev.event, data, notificationContext);
      // Capture EVERY event into the worker log BEFORE dispatch. The
      // existing per-event handlers below only fire for events the UI
      // explicitly renders (text, tool_*, plan, etc.) — many events
      // like history_compacted / provider_call / worker_log have no
      // chat-side handler but are precious for debugging stalls. Routed
      // through a coalesced store so the firehose doesn't re-render the
      // chat (only the Worker Log panel, when open, subscribes).
      const entry = buildLogEntry(ev.event, data);
      pushWorkerLog(sid, entry);
      // Stall detector (StuckBanner) only needs ~1s granularity — throttle
      // the lastEventAt commit so it isn't a per-event re-render of AgentChat.
      if (entry.ts - lastEventAtCommit >= 1000) {
        lastEventAtCommit = entry.ts;
        updateSession(sid, { lastEventAt: entry.ts });
      }
      if (!preflightCleared) {
        preflightCleared = true;
        updateSession(sid, { preflight: null });
      }
      const handler = handlers[ev.event];
      if (handler) handler(data, ev.event);
    },
    isTerminal: (ev) => ev.event === 'done' || ev.event === 'error',
  });

  try {
    await client.run();
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
              // status=idle or completed → the run actually finished or
              // never started. No error UI needed.
              updateSession(sid, { error: null });
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
