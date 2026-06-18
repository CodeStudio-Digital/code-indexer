/**
 * Live git-metadata events for one project — branch switches + ref/sequencer
 * changes, coalesced server-side (MessagePort on Electron, SSE in browser dev).
 * Subscribing arms the .git watcher. ProjectView mounts one of these and fans
 * it into the git-revision store.
 *
 * Thin wrapper over subscribeShared (same registry useFsEvents uses): one
 * refcounted connection per project, Electron-iterator reconnect via retryMs.
 */
import { useEffect, useRef } from 'react';
import { subscribeShared } from './shared-stream.js';
import { markRouteEvent } from '../lib/perf/route-startup-metrics.js';

export interface GitMetaFrameDTO {
  branch: string | null;
  detached: boolean;
  changed: Array<'head' | 'ref' | 'sequencer'>;
}

export function useGitMeta(projectId: number | null, onFrame: (frame: GitMetaFrameDTO) => void): void {
  // Latest-callback ref so consumers don't resubscribe per render.
  const cb = useRef(onFrame);
  cb.current = onFrame;

  useEffect(() => {
    if (projectId == null) return;
    // `replay: 'none'` — git-meta frames are deltas (the snapshot is the
    // server-pushed seed on subscribe), so a late joiner must not be re-fed a
    // stale frame. `retryMs: 2000` preserves the Electron-iterator reconnect.
    const unsubscribe = subscribeShared<GitMetaFrameDTO>(
      {
        key: `gitMeta:${projectId}`,
        electronVerb: 'projects.gitMetaStream',
        electronArgs: { id: projectId },
        sseUrl: `/api/projects/${projectId}/git-meta/stream`,
        sseEvent: 'git',
        retryMs: 2000,
        replay: 'none',
      },
      (frame: GitMetaFrameDTO) => cb.current(frame),
    );
    markRouteEvent('gitMeta:subscribed', { projectId });
    return unsubscribe;
  }, [projectId]);
}
