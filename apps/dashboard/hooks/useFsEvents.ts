/**
 * Live filesystem events for one project — coalesced batches from the
 * backend watcher (MessagePort on Electron, SSE in browser dev).
 * Subscribing arms the watcher server-side. One subscription per surface;
 * the Workspace fans a single stream out to the tree store + tab logic.
 */
import { useEffect, useRef } from 'react';
import { apiStream, electronApi } from '../lib/api-client.js';

export interface FsEventDTO { path: string; kind: 'upsert' | 'delete'; isDir: boolean }
interface FsEventsFrameDTO { events: FsEventDTO[] }

export function useFsEvents(projectId: number | null, onEvents: (events: FsEventDTO[]) => void): void {
  // Latest-callback ref so consumers don't resubscribe per render.
  const cb = useRef(onEvents);
  cb.current = onEvents;

  useEffect(() => {
    if (projectId == null) return;
    let cancelled = false;
    let es: EventSource | null = null;
    let closeIterator: (() => void) | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;

    const connect = (): void => {
      if (cancelled) return;
      if (electronApi()) {
        const it = apiStream<FsEventsFrameDTO>('projects.fsEventsStream', { id: projectId })[Symbol.asyncIterator]();
        closeIterator = () => { void it.return?.(); };
        void (async () => {
          try {
            while (!cancelled) {
              const r = await it.next();
              if (r.done || cancelled) break;
              if (r.value.events.length > 0) cb.current(r.value.events);
            }
          } catch { /* dropped */ }
          if (!cancelled) retry = setTimeout(connect, 2000);
        })();
      } else {
        es = new EventSource(`/api/projects/${projectId}/fs-events/stream`);
        es.addEventListener('fs', (ev) => {
          if (cancelled) return;
          try {
            const frame = JSON.parse((ev as MessageEvent).data) as FsEventsFrameDTO;
            if (frame.events.length > 0) cb.current(frame.events);
          } catch { /* bad frame */ }
        });
      }
    };
    connect();

    return () => {
      cancelled = true;
      if (retry) clearTimeout(retry);
      closeIterator?.();
      es?.close();
    };
  }, [projectId]);
}
