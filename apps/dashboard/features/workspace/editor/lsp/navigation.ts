/**
 * Providers de navegação/realce do LSP no Monaco (extraído de lspProvider.ts — W4):
 * semantic tokens (TS/JS), hover/definition/references ('*'), e o editor-opener que
 * faz o Ctrl+Click abrir a aba no workspace store. O backend roteia por linguagem.
 */
import type * as MonacoNs from 'monaco-editor';
import { apiCall } from '../../../../lib/api-client.js';
import { logLsp } from '../lsp-log.js';
import { throttledPerKey, clearThrottleKey } from '../semanticTokensThrottle.js';
import { pushCurrentNavPosition } from '../nav-commands.js';
import { cancelledWithin, withMonacoCancellation } from './cancellation.js';
import { modelBelongsToProject, relPath, toMonacoRange, type HoverDTO, type LspLocationDTO, type Monaco } from './dto.js';
import { onLspServerReady } from './server-ready.js';

// MUST stay identical to MONACO_SEMANTIC_LEGEND in
// packages/api-handlers/src/lsp/semantic-tokens-remap.ts — the backend encodes
// the token stream against this exact ordering (TS service for ts/js; server
// tokens remapped onto it for php/python/java/csharp).
const SEMANTIC_TOKEN_LEGEND: MonacoNs.languages.SemanticTokensLegend = {
  tokenTypes: [
    'class', 'enum', 'interface', 'namespace', 'typeParameter',
    'type', 'parameter', 'variable', 'enumMember', 'property',
    'function', 'method', 'struct', 'event', 'member',
  ],
  tokenModifiers: [
    'declaration', 'static', 'async', 'readonly', 'defaultLibrary', 'local',
  ],
};

// Languages whose semantic tokens the backend can serve: ts/js via the
// in-process TS service, the remaining languages via their LSP servers,
// remapped onto the legend above. Cold/absent servers return empty → Monaco
// falls back to Monarch and re-requests once the server warms (or on edit).
export const SEMANTIC_TOKEN_LANGS = [
  'typescript', 'javascript', 'php', 'python', 'java', 'csharp',
] as const;

/** Semantic tokens — TS/JS (TS service) + server-backed languages. */
export function registerSemanticTokenProviders(
  monaco: Monaco,
  projectId: number,
  ensureSynced: (model: MonacoNs.editor.ITextModel) => Promise<void> = async () => undefined,
): MonacoNs.IDisposable[] {
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
        async provideDocumentSemanticTokens(model, _lastResultId, token) {
          if (!modelBelongsToProject(model, projectId)) return { data: new Uint32Array(0) };
          // Monaco re-requests after every change — throttle per model so a
          // typing burst costs one trailing RPC instead of one per keystroke.
          const key = model.uri.toString();
          try {
            await ensureSynced(model);
            const result = await throttledPerKey(key, () =>
              withMonacoCancellation(token, (signal) =>
                apiCall<{ data: number[]; resultId?: string }>(
                  'lsp.semanticTokens',
                  { projectId, file: relPath(model) },
                  { signal },
                )));
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
  // Nudge a re-request when the owning language server warms up, so an empty
  // cold-start response cannot remain painted until the user swaps tabs.
  disposers.push(onLspServerReady(projectId, ({ languageId }) => {
    if ((SEMANTIC_TOKEN_LANGS as readonly string[]).includes(languageId)) tokensChanged.fire();
  }));
  return disposers;
}

/** Hover / definition / references — um provider '*' cada; o backend responde p/ toda linguagem. */
export function registerNavProviders(
  monaco: Monaco,
  projectId: number,
  ensureSynced: (model: MonacoNs.editor.ITextModel) => Promise<void> = async () => undefined,
): MonacoNs.IDisposable[] {
  const disposers: MonacoNs.IDisposable[] = [];
  disposers.push(
    monaco.languages.registerHoverProvider('*', {
      async provideHover(model, position, token) {
        if (!modelBelongsToProject(model, projectId)) return null;
        if (await cancelledWithin(200, token)) return null;
        try {
          await ensureSynced(model);
          const hover = await withMonacoCancellation(token, (signal) =>
            apiCall<HoverDTO | null>('lsp.hover', {
              projectId,
              file: relPath(model),
              position: { line: position.lineNumber, column: position.column },
            }, { signal }));
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
      async provideDefinition(model, position, token) {
        if (!modelBelongsToProject(model, projectId)) return [];
        try {
          await ensureSynced(model);
          const locs = await withMonacoCancellation(token, (signal) =>
            apiCall<LspLocationDTO[]>('lsp.definition', {
              projectId,
              file: relPath(model),
              position: { line: position.lineNumber, column: position.column },
            }, { signal }));
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
    monaco.languages.registerImplementationProvider('*', {
      // Ctrl+Alt+B (editor.action.goToImplementation, já no keymap). Sem
      // flushDoc — mesmo contrato do definition provider acima; o backend
      // roteia (TS service → server → fallback do índice de herança).
      async provideImplementation(model, position, token) {
        if (!modelBelongsToProject(model, projectId)) return [];
        try {
          await ensureSynced(model);
          const locs = await withMonacoCancellation(token, (signal) =>
            apiCall<LspLocationDTO[]>('lsp.implementation', {
              projectId,
              file: relPath(model),
              position: { line: position.lineNumber, column: position.column },
            }, { signal }));
          return locs.map((loc) => ({
            uri: monaco.Uri.file(loc.file),
            range: toMonacoRange(monaco, loc.range),
          }));
        } catch (err) {
          logLsp({ op: 'implementation', file: relPath(model), lang: model.getLanguageId(),
                   outcome: 'threw', err: err instanceof Error ? err.message : String(err) });
          return [];
        }
      },
    }),
  );

  disposers.push(
    monaco.languages.registerReferenceProvider('*', {
      async provideReferences(model, position, _context, token) {
        if (!modelBelongsToProject(model, projectId)) return [];
        try {
          await ensureSynced(model);
          const locs = await withMonacoCancellation(token, (signal) =>
            apiCall<LspLocationDTO[]>('lsp.references', {
              projectId,
              file: relPath(model),
              position: { line: position.lineNumber, column: position.column },
            }, { signal }));
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

      // Navegação estilo IntelliJ: registra a posição ATUAL antes do salto
      // para que Ctrl+Alt+Left volte (também suprime o eco do tracking).
      pushCurrentNavPosition();

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
