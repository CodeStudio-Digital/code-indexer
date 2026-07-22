/**
 * Live LSP server status for the active file's language.
 *
 * One-shot `lsp.serverStatus` for the first paint, then a project-scoped
 * `serverStatusStream` filtered
 * by languageId — so the chip flips green the moment a late-spawning server
 * becomes ready, instead of staying stale on the initial poll.
 *
 * Electron: MessagePort stream (auto-wired by the `Stream` suffix).
 * Browser dev: the SSE route. Mirrors useIndexStatus + diagnosticsStream.
 */
import { useEffect, useState } from 'react';
import { apiCall, apiStream, electronApi } from '../../../../lib/api-client.js';
import type { LspServerStatus, LspServerStatusFrame } from '@mcp/api-bus';

export type { LspServerStatus };

export function useServerStatus(
  projectId: number,
  languageId: string | null,
  file?: string | null,
  refreshRevision = 0,
): LspServerStatus | null {
  const [status, setStatus] = useState<LspServerStatus | null>(null);

  useEffect(() => {
    setStatus(null);
    if (!languageId) return;
    let cancelled = false;
    let es: EventSource | null = null;
    let closeIterator: (() => void) | null = null;

    // First paint. Heavy servers may remain installed and idle.
    const refresh = () => apiCall<LspServerStatus>('lsp.serverStatus', {
      projectId,
      languageId,
      file: file ?? undefined,
    })
      .then((s) => { if (!cancelled) setStatus(s); })
      .catch(() => undefined);
    void refresh();

    const apply = (f: LspServerStatusFrame) => {
      if (cancelled || f.languageId !== languageId) return;
      if (file) void refresh();
      else setStatus({ state: f.state, server: f.server, route: f.route, reason: f.reason });
    };

    if (electronApi()) {
      const it = apiStream<LspServerStatusFrame>('lsp.serverStatusStream', { projectId })[Symbol.asyncIterator]();
      closeIterator = () => { void it.return?.(); };
      void (async () => {
        try {
          while (!cancelled) {
            const r = await it.next();
            if (r.done || cancelled) break;
            apply(r.value);
          }
        } catch {
          /* stream closed (navigation/unmount) — nothing to surface */
        }
      })();
    } else {
      es = new EventSource(`/api/lsp/${projectId}/server-status/stream`);
      es.addEventListener('serverStatus', (ev) => {
        try { apply(JSON.parse((ev as MessageEvent).data) as LspServerStatusFrame); } catch { /* bad frame */ }
      });
      // EventSource auto-reconnects; no manual recovery needed.
    }

    return () => {
      cancelled = true;
      closeIterator?.();
      es?.close();
    };
  }, [projectId, languageId, file, refreshRevision]);

  return status;
}
