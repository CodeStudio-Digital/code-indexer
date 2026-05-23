import { createEventHandlers } from './handlers.js';
import type { StreamBlock, UpdateSession } from './types.js';
import { ZERO_DELTA } from './types.js';
import { ReconnectingSSEClient } from '@mcp/shared/sse/ReconnectingSSEClient.js';

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
  const { updateSession, abortMap } = deps;

  updateSession(sid, {
    streaming: true,
    currentTurn: { blocks: [] },
    doneReason: null,
    error: null,
    runDelta: ZERO_DELTA,
    reattached: !!opts.reattach,
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

  const client = new ReconnectingSSEClient({
    url: opts.url,
    method: opts.method,
    body: opts.body,
    signal: ctrl.signal,
    getLastEventId: () => lastSeenSeq,
    onEvent: (ev) => {
      if (ev.id !== undefined && ev.id > lastSeenSeq) {
        lastSeenSeq = ev.id;
        updateSession(sid, (cur) => (ev.id! > cur.lastSeenSeq ? { lastSeenSeq: ev.id! } : {}));
      }
      if (!ev.data) return;
      let data: Record<string, unknown>;
      try {
        data = JSON.parse(ev.data);
      } catch {
        return;
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
        const stateUrl = opts.url.replace(/\/attach(?:\?.*)?$/, '/state');
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
    updateSession(sid, { streaming: false });
    // Only delete if we're still the active controller — a subsequent
    // openStream for this sid may have replaced us.
    if (abortMap.get(sid) === ctrl) abortMap.delete(sid);
  }
}
