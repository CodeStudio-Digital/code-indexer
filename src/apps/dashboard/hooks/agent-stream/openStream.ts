import { createEventHandlers } from './handlers.js';
import type { StreamBlock, UpdateSession } from './types.js';
import { ZERO_DELTA } from './types.js';

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

  // Batch flushes to at most one per animation frame. Tokens arrive at
  // 50+/s; without batching every token triggers a full React re-render of
  // the persisted history. rAF collapses bursts into a single commit.
  let flushHandle: number | null = null;
  const doFlush = () => updateSession(sid, { currentTurn: { blocks: [...blocks] } });
  const flush = () => {
    if (flushHandle !== null) return;
    flushHandle = requestAnimationFrame(() => {
      flushHandle = null;
      doFlush();
    });
  };
  // Terminal events (message_complete/done/error) call flushNow to guarantee
  // the final state is committed synchronously before the buffer is cleared.
  const flushNow = () => {
    if (flushHandle !== null) {
      cancelAnimationFrame(flushHandle);
      flushHandle = null;
    }
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

  try {
    const headers: Record<string, string> = {};
    if (opts.method === 'POST') headers['Content-Type'] = 'application/json';
    if (typeof opts.lastEventId === 'number' && opts.lastEventId >= 0) {
      headers['Last-Event-ID'] = String(opts.lastEventId);
    }
    const res = await fetch(opts.url, {
      method: opts.method,
      headers,
      body: opts.method === 'POST' ? JSON.stringify(opts.body ?? {}) : undefined,
      signal: ctrl.signal,
    });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // Parse SSE events (separated by blank line)
      const events = buffer.split('\n\n');
      buffer = events.pop() ?? '';
      for (const raw of events) {
        const lines = raw.split('\n');
        let eventName = 'message';
        let dataStr = '';
        let eventId: number | null = null;
        for (const ln of lines) {
          if (ln.startsWith('event:')) eventName = ln.slice(6).trim();
          else if (ln.startsWith('data:')) dataStr += ln.slice(5).trim();
          else if (ln.startsWith('id:')) {
            const n = parseInt(ln.slice(3).trim(), 10);
            if (Number.isFinite(n)) eventId = n;
          }
        }
        if (!dataStr) continue;
        let data: Record<string, unknown>;
        try {
          data = JSON.parse(dataStr);
        } catch {
          continue;
        }
        if (eventId !== null) {
          const seq = eventId;
          updateSession(sid, (cur) => (seq > cur.lastSeenSeq ? { lastSeenSeq: seq } : {}));
        }
        const handler = handlers[eventName];
        if (handler) handler(data, eventName);
      }
    }
  } catch (e) {
    if ((e as Error).name !== 'AbortError') {
      updateSession(sid, { error: e instanceof Error ? e.message : String(e) });
    }
  } finally {
    if (flushHandle !== null) {
      cancelAnimationFrame(flushHandle);
      flushHandle = null;
    }
    updateSession(sid, { streaming: false });
    // Only delete if we're still the active controller — a subsequent
    // openStream for this sid may have replaced us.
    if (abortMap.get(sid) === ctrl) abortMap.delete(sid);
  }
}
