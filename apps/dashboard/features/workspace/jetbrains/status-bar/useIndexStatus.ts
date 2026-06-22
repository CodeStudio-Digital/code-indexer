/**
 * Live structural-index status for one project.
 *
 * Electron: MessagePort stream via `projects.indexStatusStream` (auto-wired
 * by the `Stream` suffix). Browser dev: the SSE route. Both deliver an
 * initial frame immediately, then one frame per transition (coalesced
 * ~150ms server-side), so there is no polling.
 */
import { useEffect, useState } from 'react';
import { subscribeShared, type StreamDescriptor } from '../../../../hooks/shared-stream.js';
import { markRouteEvent } from '../../../../lib/perf/route-startup-metrics.js';
import type { ProjectIndexStatus } from '@mcp/api-bus';

export type { ProjectIndexStatus };

/**
 * Shared per-project descriptor — the status bar, the chat composer gate and
 * any other consumer of the SAME projectId ride ONE stream instead of opening
 * N. `replay: 'last'` re-delivers the current snapshot to a late joiner, so a
 * second consumer is up to date instantly (no wait for the next transition).
 */
function indexStatusDescriptor(projectId: number): StreamDescriptor {
  return {
    key: `indexStatus:${projectId}`,
    electronVerb: 'projects.indexStatusStream',
    electronArgs: { id: projectId },
    sseUrl: `/api/projects/${projectId}/index-status/stream`,
    sseEvent: 'status',
    replay: 'last',
  };
}

/** True while the project id is a real, openable target. */
function validProject(projectId: number): boolean {
  return Number.isInteger(projectId) && projectId > 0;
}

export function useIndexStatus(projectId: number): ProjectIndexStatus | null {
  const [status, setStatus] = useState<ProjectIndexStatus | null>(null);

  useEffect(() => {
    setStatus(null);
    // No project (e.g. a chat with no session selected passes 0) — never open a
    // stream for a non-positive id (the route 404s and EventSource would retry
    // in a loop in browser-dev). Hardens every caller.
    if (!validProject(projectId)) return;

    let firstFrame = true;
    return subscribeShared<ProjectIndexStatus>(indexStatusDescriptor(projectId), (frame) => {
      if (firstFrame) {
        firstFrame = false;
        markRouteEvent('indexStatus:first-frame', { projectId, phase: frame.phase });
      }
      setStatus(frame);
    });
  }, [projectId]);

  return status;
}

/**
 * Boolean selector: true while the project is ACTIVELY indexing (scanning or
 * structural pass). Unlike {@link useIndexStatus}, it re-renders the caller
 * ONLY when the boolean flips — NOT on every ~150ms progress frame. Heavy,
 * always-mounted consumers (the chat surface) use this so the per-frame index
 * stream can't drive a full-subtree re-render storm during a large-project
 * open. The live progress text lives in a tiny isolated leaf instead.
 */
export function useIndexBusy(projectId: number): boolean {
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setBusy(false);
    if (!validProject(projectId)) return;

    return subscribeShared<ProjectIndexStatus>(indexStatusDescriptor(projectId), (frame) => {
      const next = frame.phase === 'scanning' || frame.phase === 'structural_indexing';
      // Bail unless the boolean actually changed — keeps the heavy consumer off
      // React's render path for the hundreds of progress frames in between.
      setBusy((prev) => (prev === next ? prev : next));
    });
  }, [projectId]);

  return busy;
}
