/**
 * Providers de navegação/realce do LSP no Monaco (extraído de lspProvider.ts — W4):
 * semantic tokens (TS/JS), hover/definition/references ('*'), e o editor-opener que
 * faz o Ctrl+Click abrir a aba no workspace store. O backend roteia por linguagem.
 */
import type * as MonacoNs from 'monaco-editor';
import { apiCall, apiStream, electronApi } from '../../../../lib/api-client.js';
import { logLsp } from '../lsp-log.js';
import { throttledPerKey, clearThrottleKey } from '../semanticTokensThrottle.js';
import { relPath, toMonacoRange, type HoverDTO, type LspLocationDTO, type Monaco } from './dto.js';

// MUST stay identical to MONACO_SEMANTIC_LEGEND in
// packages/api-handlers/src/lsp/semantic-tokens-remap.ts — the backend encodes
// the token stream against this exact ordering (TS service for ts/js; server
// tokens remapped onto it for php/python).
const SEMANTIC_TOKEN_LEGEND: MonacoNs.languages.SemanticTokensLegend = {
  tokenTypes: [
    'class', 'enum', 'interface', 'namespace', 'typeParameter',
    'type', 'parameter', 'variable', 'enumMember', 'property',
    'function', 'method',
  ],
  tokenModifiers: [
    'declaration', 'static', 'async', 'readonly', 'defaultLibrary', 'local',
  ],
};

// Languages whose semantic tokens the backend can serve: ts/js via the
// in-process TS service, php/python via their LSP server (intelephense/pyright),
// remapped onto the legend above. Cold/absent servers return empty → Monaco
// falls back to Monarch and re-requests once the server warms (or on edit).
const SEMANTIC_TOKEN_LANGS = ['typescript', 'javascript', 'php', 'python'] as const;

/** Semantic tokens — TS/JS (TS service) + php/python (language server). */
export function registerSemanticTokenProviders(monaco: Monaco, projectId: number): MonacoNs.IDisposable[] {
  const disposers: MonacoNs.IDisposable[] = [];
  // Firing this tells Monaco to re-request semantic tokens for visible models.
  // The TS service answers instantly, but php/python servers spawn cold — the
  // first open of a .php returns empty (Monarch only) until the server is ready.
  // We fire on the server's 'ready' transition so the file colours WITHOUT
  // needing a keystroke to nudge a re-request.
  const tokensChanged = new monaco.Emitter<void>();
  disposers.push(tokensChanged);
  for (const lang of SEMANTIC_TOKEN_LANGS) {
    disposers.push(
      monaco.languages.registerDocumentSemanticTokensProvider(lang, {
        onDidChange: tokensChanged.event,
        getLegend: () => SEMANTIC_TOKEN_LEGEND,
        async provideDocumentSemanticTokens(model) {
          // Monaco re-requests after every change — throttle per model so a
          // typing burst costs one trailing RPC instead of one per keystroke.
          const key = model.uri.toString();
          try {
            const result = await throttledPerKey(key, () =>
              apiCall<{ data: number[]; resultId?: string }>(
                'lsp.semanticTokens',
                { projectId, file: relPath(model) },
              ));
            if (model.isDisposed()) {
              clearThrottleKey(key);
              return { data: new Uint32Array(0) };
            }
            return { data: new Uint32Array(result.data), resultId: result.resultId };
          } catch (err) {
            logLsp({ op: 'semanticTokens', file: relPath(model), lang: model.getLanguageId(),
                     outcome: 'threw', err: err instanceof Error ? err.message : String(err) });
            return { data: new Uint32Array(0) };
          }
        },
        releaseDocumentSemanticTokens() {
          /* no-op — backend doesn't keep cached results yet */
        },
      }),
    );
  }
  // Nudge a re-request when a language server warms up, so the first .php/.py
  // opened before the server was ready picks up semantic colours without an edit.
  disposers.push(startSemanticTokensRefresh(projectId, () => tokensChanged.fire()));
  return disposers;
}

/**
 * Subscribe to the LSP server-status stream and call `refresh` whenever a
 * server transitions to 'ready'. Mirrors diagnosticsStream's transport split
 * (Electron MessagePort vs SSE) with a light reconnect. Best-effort — a dropped
 * stream just means colours arrive on the next edit instead.
 */
function startSemanticTokensRefresh(projectId: number, refresh: () => void): MonacoNs.IDisposable {
  interface StatusFrame { languageId?: string; state?: string }
  let stopped = false;
  let es: EventSource | null = null;
  let closeIterator: (() => void) | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  const onFrame = (f: StatusFrame): void => {
    if (f?.state === 'ready') refresh();
  };

  const connect = (): void => {
    if (stopped) return;
    if (electronApi()) {
      const it = apiStream<StatusFrame>('lsp.serverStatusStream', { projectId })[Symbol.asyncIterator]();
      closeIterator = () => { void it.return?.(); };
      void (async () => {
        try {
          while (!stopped) {
            const r = await it.next();
            if (r.done || stopped) break;
            onFrame(r.value);
          }
        } catch { /* stream dropped */ }
        if (!stopped) retryTimer = setTimeout(connect, 2000);
      })();
    } else {
      es = new EventSource(`/api/lsp/${projectId}/server-status/stream`);
      es.addEventListener('serverStatus', (ev) => {
        if (stopped) return;
        try { onFrame(JSON.parse((ev as MessageEvent).data) as StatusFrame); } catch { /* bad frame */ }
      });
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

/** Hover / definition / references — um provider '*' cada; o backend responde p/ toda linguagem. */
export function registerNavProviders(monaco: Monaco, projectId: number): MonacoNs.IDisposable[] {
  const disposers: MonacoNs.IDisposable[] = [];
  disposers.push(
    monaco.languages.registerHoverProvider('*', {
      async provideHover(model, position) {
        try {
          const hover = await apiCall<HoverDTO | null>('lsp.hover', {
            projectId,
            file: relPath(model),
            position: { line: position.lineNumber, column: position.column },
          });
          if (!hover) return null;
          return {
            contents: [{ value: hover.contents }],
            range: hover.range ? toMonacoRange(monaco, hover.range) : undefined,
          };
        } catch (err) {
          logLsp({ op: 'hover', file: relPath(model), lang: model.getLanguageId(),
                   outcome: 'threw', err: err instanceof Error ? err.message : String(err) });
          return null;
        }
      },
    }),
  );

  disposers.push(
    monaco.languages.registerDefinitionProvider('*', {
      async provideDefinition(model, position) {
        try {
          const locs = await apiCall<LspLocationDTO[]>('lsp.definition', {
            projectId,
            file: relPath(model),
            position: { line: position.lineNumber, column: position.column },
          });
          return locs.map((loc) => ({
            // Backend returns absolute canonical paths so Monaco can match
            // open models or hand off to the editor opener below.
            uri: monaco.Uri.file(loc.file),
            range: toMonacoRange(monaco, loc.range),
          }));
        } catch (err) {
          logLsp({ op: 'definition', file: relPath(model), lang: model.getLanguageId(),
                   outcome: 'threw', err: err instanceof Error ? err.message : String(err) });
          return [];
        }
      },
    }),
  );

  disposers.push(
    monaco.languages.registerReferenceProvider('*', {
      async provideReferences(model, position) {
        try {
          const locs = await apiCall<LspLocationDTO[]>('lsp.references', {
            projectId,
            file: relPath(model),
            position: { line: position.lineNumber, column: position.column },
          });
          return locs.map((loc) => ({
            uri: monaco.Uri.file(loc.file),
            range: toMonacoRange(monaco, loc.range),
          }));
        } catch (err) {
          logLsp({ op: 'references', file: relPath(model), lang: model.getLanguageId(),
                   outcome: 'threw', err: err instanceof Error ? err.message : String(err) });
          return [];
        }
      },
    }),
  );
  return disposers;
}

/**
 * Bridge Monaco's "open this URI" intent to the workspace tab store. Sem ele, o
 * Ctrl+Click entrega o URI ao opener embutido (que assume um workbench Monaco
 * hospedado, não o nosso dashboard). Retorna true = "tratamos"; false só se o
 * resource não é `file:` (ex.: link https — deixa o browser).
 */
export function registerEditorOpener(monaco: Monaco, projectId: number): MonacoNs.IDisposable {
  let projectRoot: string | null = null;
  const ensureRoot = async (): Promise<string | null> => {
    if (projectRoot !== null) return projectRoot;
    try {
      const project = await apiCall<{ root_path?: string }>('projects.get', { id: projectId });
      if (project?.root_path) projectRoot = project.root_path;
    } catch {
      /* swallow — opener degrades to no-op */
    }
    return projectRoot;
  };

  function toRel(root: string, absolute: string): string | null {
    // Canonicalise both sides to lowercase-drive + forward slash.
    const norm = (p: string): string =>
      p.replace(/\\/g, '/').replace(/^([a-zA-Z]):/, (_m, d: string) => d.toLowerCase() + ':');
    const a = norm(absolute);
    const r = norm(root).replace(/\/$/, '');
    if (!a.toLowerCase().startsWith(r.toLowerCase() + '/')) return null;
    return a.slice(r.length + 1);
  }

  // `registerEditorOpener` arrived in monaco ≥0.34. We're on 0.52, so this is
  // guaranteed present — but guard anyway so a future Monaco downgrade doesn't crash.
  const ed = monaco.editor as unknown as {
    registerEditorOpener?: (opener: {
      openCodeEditor: (
        source: MonacoNs.editor.ICodeEditor,
        resource: MonacoNs.Uri,
        selectionOrPosition?: MonacoNs.IRange | MonacoNs.IPosition,
      ) => boolean | Promise<boolean>;
    }) => MonacoNs.IDisposable;
  };
  if (typeof ed.registerEditorOpener !== 'function') {
    return { dispose() {} };
  }

  return ed.registerEditorOpener({
    async openCodeEditor(source, resource, selectionOrPosition) {
      if (resource.scheme !== 'file') return false;
      const root = await ensureRoot();
      if (!root) return false;
      const rel = toRel(root, resource.fsPath);
      if (!rel) return false;

      // Pull dynamically — keeps this module reusable in tests + helps tree-shaking.
      const { useWorkspaceStore } = await import('../../../../state/workspace.js');
      const store = useWorkspaceStore.getState();
      const existing = store.openFiles.find((f) => f.path === rel && f.projectId === projectId);
      if (existing) {
        store.setActive(rel);
      } else {
        store.openFile({ kind: 'file', projectId, path: rel, content: null, dirty: false, lastModified: null });
      }

      // Position the cursor at the requested range/position once the editor swap
      // is committed. Monaco re-mounts on tab change, so we wait a tick.
      if (selectionOrPosition) {
        const line =
          'startLineNumber' in selectionOrPosition
            ? selectionOrPosition.startLineNumber
            : selectionOrPosition.lineNumber;
        const column =
          'startColumn' in selectionOrPosition
            ? selectionOrPosition.startColumn
            : selectionOrPosition.column;
        setTimeout(() => {
          source?.revealPositionInCenter?.({ lineNumber: line, column });
          source?.setPosition?.({ lineNumber: line, column });
        }, 50);
      }
      return true;
    },
  });
}
