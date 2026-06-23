/**
 * Providers de navegação/realce do LSP no Monaco (extraído de lspProvider.ts — W4):
 * semantic tokens (TS/JS), hover/definition/references ('*'), e o editor-opener que
 * faz o Ctrl+Click abrir a aba no workspace store. O backend roteia por linguagem.
 */
import type * as MonacoNs from 'monaco-editor';
import { apiCall } from '../../../../lib/api-client.js';
import { logLsp } from '../lsp-log.js';
import { throttledPerKey, clearThrottleKey } from '../semanticTokensThrottle.js';
import { relPath, toMonacoRange, type HoverDTO, type LspLocationDTO, type Monaco } from './dto.js';

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

/** Semantic tokens (TS/JS — precisam do TS service project-aware). */
export function registerSemanticTokenProviders(monaco: Monaco, projectId: number): MonacoNs.IDisposable[] {
  const disposers: MonacoNs.IDisposable[] = [];
  for (const lang of ['typescript', 'javascript']) {
    disposers.push(
      monaco.languages.registerDocumentSemanticTokensProvider(lang, {
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
  return disposers;
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
