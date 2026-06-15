/**
 * Live structural-index status for one project.
 *
 * Electron: MessagePort stream via `projects.indexStatusStream` (auto-wired
 * by the `Stream` suffix). Browser dev: the SSE route. Both deliver an
 * initial frame immediately, then one frame per transition (coalesced
 * ~150ms server-side), so there is no polling.
 */
import { useEffect, useState } from 'react';
import { apiStream, electronApi } from '../../../../lib/api-client.js';
import type { ProjectIndexStatus } from '@mcp/api-bus';

export type { ProjectIndexStatus };

export function useIndexStatus(projectId: number): ProjectIndexStatus | null {
  const [status, setStatus] = useState<ProjectIndexStatus | null>(null);

  useEffect(() => {
    setStatus(null);
    let cancelled = false;
    let es: EventSource | null = null;
    let closeIterator: (() => void) | null = null;

    if (electronApi()) {
      const it = apiStream<ProjectIndexStatus>('projects.indexStatusStream', { id: projectId })[Symbol.asyncIterator]();
      closeIterator = () => { void it.return?.(); };
      void (async () => {
        try {
          while (!cancelled) {
            const r = await it.next();
            if (r.done || cancelled) break;
            setStatus(r.value);
          }
        } catch {
          /* stream closed (navigation/unmount) — nothing to surface */
        }
      })();
    } else {
      es = new EventSource(`/api/projects/${projectId}/index-status/stream`);
      es.addEventListener('status', (ev) => {
        if (cancelled) return;
        try { setStatus(JSON.parse((ev as MessageEvent).data) as ProjectIndexStatus); } catch { /* ignore bad frame */ }
      });
      // EventSource auto-reconnects; the reopened stream re-sends the
      // initial frame, so no manual recovery needed.
    }

    return () => {
      cancelled = true;
      closeIterator?.();
      es?.close();
    };
  }, [projectId]);

  return status;
}
