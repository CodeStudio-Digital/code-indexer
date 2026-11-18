/**
 * Live filesystem events for one project — coalesced batches from the
 * backend watcher (MessagePort on Electron, SSE in browser dev).
 * Subscribing arms the watcher server-side. One subscription per surface;
 * the Workspace fans a single stream out to the tree store + tab logic.
 */
import { useEffect, useRef } from 'react';
import { subscribeShared } from './shared-stream.js';
import { markRouteEvent } from '../lib/perf/route-startup-metrics.js';

export interface FsEventDTO { path: string; kind: 'upsert' | 'delete'; isDir: boolean }
interface FsEventsFrameDTO { events: FsEventDTO[] }

export function useFsEvents(projectId: number | null, onEvents: (events: FsEventDTO[]) => void): void {
  // Latest-callback ref so consumers don't resubscribe per render.
  const latest = useRef({ projectId, onEvents });
  latest.current = { projectId, onEvents };

  useEffect(() => {
    if (projectId == null) return;
    // Shared per-project watcher subscription (refcounted; one stream regardless
    // of how many surfaces subscribe). `replay: 'none'` — these frames are
    // incremental deltas, NOT a snapshot, so a late joiner must not be re-fed a
    // stale batch. `retryMs: 2000` preserves the Electron-iterator reconnect.
    const unsubscribe = subscribeShared<FsEventsFrameDTO>(
      {
        key: `fsEvents:${projectId}`,
        electronVerb: 'projects.fsEventsStream',
        electronArgs: { id: projectId },
        sseUrl: `/api/projects/${projectId}/fs-events/stream`,
        sseEvent: 'fs',
        retryMs: 2000,
        replay: 'none',
      },
      (frame: FsEventsFrameDTO) => {
        if (latest.current.projectId === projectId && frame.events.length > 0) latest.current.onEvents(frame.events);
      },
    );
    markRouteEvent('fsEvents:subscribed', { projectId });
    return unsubscribe;
  }, [projectId]);
}
