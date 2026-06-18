/**
 * Refcounted shared subscriptions for backend push streams.
 *
 * Several surfaces subscribe to the SAME per-project stream (most notably the
 * index-status stream, read by the status bar AND the chat composer gate AND
 * elsewhere). Each useEffect opened its OWN connection — N identical streams
 * per projectId. This registry collapses identical subscriptions (same `key`)
 * onto ONE underlying connection: it opens on the first subscriber, fans every
 * frame out to all listeners, and closes when the last subscriber leaves.
 *
 * Transport-agnostic: Electron MessagePort iterator (`apiStream`) or browser
 * EventSource — mirrors the per-hook code it replaces.
 */
import { apiStream, electronApi } from '../lib/api-client.js';

export type ReplayMode = 'none' | 'last';

export interface StreamDescriptor {
  /** Unique per logical stream instance, e.g. `indexStatus:42`. */
  key: string;
  /** api-bus verb for the Electron MessagePort transport. */
  electronVerb: string;
  /** Payload for the Electron verb (shape is verb-specific). */
  electronArgs: unknown;
  /** Browser-dev SSE endpoint. */
  sseUrl: string;
  /** SSE event name to listen for. */
  sseEvent: string;
  /** Reconnect delay (ms) for the Electron iterator after a drop. Omit to not
   *  reconnect (browser EventSource auto-reconnects regardless). */
  retryMs?: number;
  /** 'last' replays the most recent frame to a late joiner (state snapshots
   *  like index-status); 'none' for delta/event streams (fs-events). */
  replay?: ReplayMode;
}

type Listener = (frame: unknown) => void;

interface Entry {
  listeners: Set<Listener>;
  last: { frame: unknown } | null;
  replay: ReplayMode;
  close: () => void;
}

const registry = new Map<string, Entry>();

function open(d: StreamDescriptor): Entry {
  const listeners = new Set<Listener>();
  const entry: Entry = { listeners, last: null, replay: d.replay ?? 'none', close: () => {} };
  let closed = false;
  let es: EventSource | null = null;
  let closeIterator: (() => void) | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null;

  const emit = (frame: unknown): void => {
    if (entry.replay === 'last') entry.last = { frame };
    for (const l of listeners) l(frame);
  };

  const connect = (): void => {
    if (closed) return;
    if (electronApi()) {
      const it = apiStream<unknown>(d.electronVerb, d.electronArgs)[Symbol.asyncIterator]();
      closeIterator = () => { void it.return?.(); };
      void (async () => {
        try {
          while (!closed) {
            const r = await it.next();
            if (r.done || closed) break;
            emit(r.value);
          }
        } catch { /* stream dropped */ }
        if (!closed && d.retryMs != null) retry = setTimeout(connect, d.retryMs);
      })();
    } else {
      es = new EventSource(d.sseUrl);
      es.addEventListener(d.sseEvent, (ev) => {
        if (closed) return;
        try { emit(JSON.parse((ev as MessageEvent).data)); } catch { /* bad frame */ }
      });
    }
  };
  connect();

  entry.close = (): void => {
    closed = true;
    if (retry) clearTimeout(retry);
    closeIterator?.();
    es?.close();
  };
  return entry;
}

/**
 * Subscribe to a shared stream. Identical `key`s share ONE underlying
 * connection; it opens on the first subscriber and closes when the last
 * unsubscribes. Returns an unsubscribe fn (use directly as a useEffect cleanup).
 */
export function subscribeShared<T>(d: StreamDescriptor, onFrame: (frame: T) => void): () => void {
  let entry = registry.get(d.key);
  if (!entry) {
    entry = open(d);
    registry.set(d.key, entry);
  }
  const listener = onFrame as Listener;
  entry.listeners.add(listener);
  // Replay the current snapshot so a late joiner is immediately up to date.
  if (entry.replay === 'last' && entry.last) onFrame(entry.last.frame as T);

  return () => {
    const e = registry.get(d.key);
    if (!e) return;
    e.listeners.delete(listener);
    if (e.listeners.size === 0) {
      e.close();
      registry.delete(d.key);
    }
  };
}
