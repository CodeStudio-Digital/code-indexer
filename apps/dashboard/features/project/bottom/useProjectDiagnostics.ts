/**
 * Project-wide diagnostics feed for the Problems panel.
 *
 * Subscribes to the SAME push stream the editor uses for Monaco markers
 * (`lsp.diagnosticsStream`) but accumulates EVERY file's frames into a flat
 * list instead of applying markers to open models — so problems show up even
 * for files that aren't open in a tab. Connection/retry mirrors
 * `editor/diagnosticsStream.ts` (Electron MessagePort + browser SSE fallback).
 */
import { useEffect, useMemo, useState } from 'react';
import type { DiagnosticsFrame } from '@mcp/api-bus';
import { apiStream, electronApi } from '../../../lib/api-client.js';
import {
  applyFrame,
  emptyDiagnosticsState,
  flatten,
  type DiagnosticsState,
  type FlatDiagnostics,
} from './diagnostics-reducer.js';

export function useProjectDiagnostics(projectId: number, enabled = true): FlatDiagnostics {
  const [state, setState] = useState<DiagnosticsState>(emptyDiagnosticsState);

  useEffect(() => {
    // Gate (W2/P3): sem o painel Problems visível, NÃO assina o stream — durante a
    // indexação ele despeja muitos frames e era a janela de lag mesmo com o terminal
    // fechado. O badge religa assim que o usuário abre Problems pela 1ª vez.
    if (!enabled) { setState(emptyDiagnosticsState()); return; }
    setState(emptyDiagnosticsState()); // drop the previous project's problems
    let stopped = false;
    let es: EventSource | null = null;
    let closeIterator: (() => void) | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;

    const onFrame = (frame: DiagnosticsFrame): void => {
      if (stopped) return;
      setState((prev) => applyFrame(prev, frame));
    };

    const connect = (): void => {
      if (stopped) return;
      if (electronApi()) {
        const it = apiStream<DiagnosticsFrame>('lsp.diagnosticsStream', { projectId })[Symbol.asyncIterator]();
        closeIterator = () => { void it.return?.(); };
        void (async () => {
          try {
            while (!stopped) {
              const r = await it.next();
              if (r.done || stopped) break;
              onFrame(r.value);
            }
          } catch { /* stream dropped */ }
          // Producer restarted (backend reload) — reconnect with backoff.
          if (!stopped) retry = setTimeout(connect, 2000);
        })();
      } else {
        es = new EventSource(`/api/lsp/${projectId}/diagnostics/stream`);
        es.addEventListener('diagnostics', (ev) => {
          if (stopped) return;
          try { onFrame(JSON.parse((ev as MessageEvent).data) as DiagnosticsFrame); } catch { /* bad frame */ }
        });
        // EventSource auto-reconnects.
      }
    };
    connect();

    return () => {
      stopped = true;
      if (retry) clearTimeout(retry);
      closeIterator?.();
      es?.close();
    };
  }, [projectId, enabled]);

  return useMemo(() => flatten(state), [state]);
}
