/**
 * Diagnostics PUSH consumer — replaces the 1s polling loop. One stream per
 * project: Electron rides the auto-mounted MessagePort
 * (`lsp.diagnosticsStream`); browser-dev uses the SSE route. Frames are
 * per-(file, source) and `diagnostics: []` clears — markers are owned per
 * source (`mcp-lsp:ts`, `mcp-lsp:lsp:intelephense`, …) so backends never
 * clobber each other.
 */
import type * as MonacoNs from 'monaco-editor';
import { apiStream, electronApi } from '../../../lib/api-client.js';
import { parseModelPath } from './editor-models-path.js';

type Monaco = typeof MonacoNs;

interface PositionDTO { line: number; column: number }
interface DiagnosticsFrameDTO {
  file: string;
  source: string;
  diagnostics: Array<{
    range: { start: PositionDTO; end: PositionDTO };
    severity: 'error' | 'warning' | 'info' | 'hint';
    message: string;
    source?: string;
    code?: string | number;
  }>;
}

function applyFrame(monaco: Monaco, projectId: number, frame: DiagnosticsFrameDTO): void {
  // frame.file é o relpath limpo (chave do modelo no backend); parseModelPath faz o
  // strip do prefixo de namespacing por projectId (W1b) para casar. Casa TAMBÉM pelo
  // projectId (não só relpath): dois projetos podem ter o mesmo relpath em modelos
  // namespaceados distintos — sem o guard, markers de um cairiam no modelo do outro
  // se ambos coexistirem (espelha modelFor). projectId null = modelo legado/OFF-mode.
  const model = monaco.editor
    .getModels()
    .find((m) => {
      const p = parseModelPath(m.uri.path);
      return p.relPath === frame.file && (p.projectId === projectId || p.projectId === null);
    });
  if (!model || model.isDisposed()) return;
  const sev = monaco.MarkerSeverity;
  const severity = { error: sev.Error, warning: sev.Warning, info: sev.Info, hint: sev.Hint };
  monaco.editor.setModelMarkers(
    model,
    `mcp-lsp:${frame.source}`,
    frame.diagnostics.map((d) => ({
      severity: severity[d.severity],
      message: d.message,
      startLineNumber: d.range.start.line,
      startColumn: d.range.start.column,
      endLineNumber: Math.max(d.range.start.line, d.range.end.line),
      endColumn: Math.max(d.range.start.column, d.range.end.column),
      source: d.source ?? frame.source,
      code: d.code != null ? String(d.code) : undefined,
    })),
  );
}

export function startDiagnosticsStream(monaco: Monaco, projectId: number): MonacoNs.IDisposable {
  let stopped = false;
  let es: EventSource | null = null;
  let closeIterator: (() => void) | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  const connect = (): void => {
    if (stopped) return;
    if (electronApi()) {
      const it = apiStream<DiagnosticsFrameDTO>('lsp.diagnosticsStream', { projectId })[Symbol.asyncIterator]();
      closeIterator = () => { void it.return?.(); };
      void (async () => {
        try {
          while (!stopped) {
            const r = await it.next();
            if (r.done || stopped) break;
            applyFrame(monaco, projectId, r.value);
          }
        } catch { /* stream dropped */ }
        // Producer side restarted (backend reload) — reconnect with backoff.
        if (!stopped) retryTimer = setTimeout(connect, 2000);
      })();
    } else {
      es = new EventSource(`/api/lsp/${projectId}/diagnostics/stream`);
      es.addEventListener('diagnostics', (ev) => {
        if (stopped) return;
        try { applyFrame(monaco, projectId, JSON.parse((ev as MessageEvent).data) as DiagnosticsFrameDTO); } catch { /* bad frame */ }
      });
      // EventSource auto-reconnects.
    }
  };
  connect();

  return {
    dispose() {
      stopped = true;
      if (retryTimer) clearTimeout(retryTimer);
      closeIterator?.();
      es?.close();
    },
  };
}
