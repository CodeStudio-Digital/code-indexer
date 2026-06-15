/**
 * Wire the @mcp/api-bus lsp.* methods into Monaco's provider registry.
 *
 * Onda 2 architecture (IDE-grade):
 *   - documentSync streams didOpen/didChange/didClose — position-based
 *     calls carry ONLY {file, position}; the full-buffer-per-keystroke
 *     payload is gone (the backend serves the live buffer to every
 *     language backend).
 *   - diagnostics are PUSHED (diagnosticsStream) — the 1s polling loop
 *     over every open model is gone.
 *   - providers register for '*': the BACKEND routes by language
 *     (ts/js → in-process TS service; languages with an installed LSP
 *     server → that server; everything else → the structural-index
 *     fallback with real line/col). The old client-side "weak definition"
 *     grep fallback died — ranking by import-graph lives server-side now.
 *
 * Registration is idempotent per projectId — calling it multiple times
 * with the same projectId is a no-op. Switching projects tears down the
 * old providers and re-registers.
 */

import type * as MonacoNs from 'monaco-editor';
import { apiCall } from '../../../lib/api-client.js';
import { startDocumentSync } from './documentSync.js';
import { startDiagnosticsStream } from './diagnosticsStream.js';
import { registerInlineCompletions } from './inlineCompletionProvider.js';
import { throttledPerKey, clearThrottleKey } from './semanticTokensThrottle.js';

type Monaco = typeof MonacoNs;

/** Trigger characters per language family; '*' (manual Ctrl+Space) covers the rest. */
const COMPLETION_TRIGGERS: Record<string, string[]> = {
  typescript: ['.', '"', "'", '/', '@', '<', '#'],
  javascript: ['.', '"', "'", '/', '@', '<', '#'],
  php: ['$', '>', ':', '\\'],
  python: ['.'],
};

// One disposer set per projectId. New project = wipe and re-register.
const registrations = new Map<number, { disposers: MonacoNs.IDisposable[] }>();

interface Position {
  line: number;
  column: number;
}

interface CompletionItemDTO {
  label: string;
  kind: string;
  detail?: string;
  documentation?: string;
  insertText?: string;
  additionalTextEdits?: Array<{ range: { start: Position; end: Position }; newText: string }>;
  raw?: unknown;
  // Fidelity fields (mirror api-bus CompletionItem — hand-maintained DTO).
  sortText?: string;
  filterText?: string;
  insertTextFormat?: 1 | 2;
  preselect?: boolean;
  labelDetails?: { detail?: string; description?: string };
  commitCharacters?: string[];
  textEdit?: { range: { start: Position; end: Position }; newText: string };
}

/** Our suggestion carries the opaque LSP item + file for lazy resolve. */
type SuggestionWithMeta = MonacoNs.languages.CompletionItem & {
  _raw?: unknown;
  _file?: string;
};

function toEditOps(
  monaco: Monaco,
  edits: NonNullable<CompletionItemDTO['additionalTextEdits']>,
): MonacoNs.editor.ISingleEditOperation[] {
  return edits.map((e) => ({
    range: new monaco.Range(e.range.start.line, e.range.start.column, e.range.end.line, e.range.end.column),
    text: e.newText,
  }));
}

interface HoverDTO {
  contents: string;
  range?: { start: Position; end: Position };
}

interface LspLocationDTO {
  file: string;
  range: { start: Position; end: Position };
}

function toMonacoRange(monaco: Monaco, r: { start: Position; end: Position }): MonacoNs.IRange {
  return new monaco.Range(r.start.line, r.start.column, r.end.line, r.end.column);
}

function mapCompletionKind(monaco: Monaco, kind: string): MonacoNs.languages.CompletionItemKind {
  // Superset of TS ScriptElementKind + the index fallback's symbol kinds.
  const k = monaco.languages.CompletionItemKind;
  switch (kind) {
    case 'method': return k.Method;
    case 'function': return k.Function;
    case 'constructor': return k.Constructor;
    case 'property': return k.Property;
    case 'var':
    case 'let':
    case 'const':
    case 'local var':
    case 'variable':
    case 'parameter': return k.Variable;
    case 'constant': return k.Constant;
    case 'class':
    case 'trait': return k.Class;
    case 'interface': return k.Interface;
    case 'struct': return k.Struct;
    case 'enum': return k.Enum;
    case 'enum member': return k.EnumMember;
    case 'field': return k.Field;
    case 'event': return k.Event;
    case 'namespace':
    case 'module': return k.Module;
    case 'keyword': return k.Keyword;
    case 'type':
    case 'type parameter': return k.TypeParameter;
    default: return k.Text;
  }
}

function relPath(model: MonacoNs.editor.ITextModel): string {
  return model.uri.path.replace(/^\//, '');
}

export function registerLspProviders(monaco: Monaco, projectId: number): void {
  // Tear down previous registration if the projectId changed.
  if (registrations.has(projectId)) return;
  for (const [otherId, reg] of registrations) {
    if (otherId !== projectId) {
      reg.disposers.forEach((d) => d.dispose());
      registrations.delete(otherId);
    }
  }

  const disposers: MonacoNs.IDisposable[] = [];

  // Document sync FIRST — didOpen lands before the first provider request
  // in the common path, so the backend reads the live buffer (a lost race
  // degrades to disk content, never an error).
  disposers.push(startDocumentSync(monaco, projectId));
  disposers.push(startDiagnosticsStream(monaco, projectId));

  // ─── Semantic token provider (TS/JS — needs the project-aware TS
  // service; Monaco's bundled TS worker has no tsconfig/node_modules) ───
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
          } catch {
            return { data: new Uint32Array(0) };
          }
        },
        releaseDocumentSemanticTokens() {
          /* no-op — backend doesn't keep cached results yet */
        },
      }),
    );
  }

  // ─── Completion — per-family trigger characters + a '*' fallback for
  // every other language (manual Ctrl+Space). The backend decides which
  // backend answers; registering '*' on top of a specific language would
  // double-call, so the fallback skips covered ids. ───
  const wordRange = (model: MonacoNs.editor.ITextModel, position: MonacoNs.Position): MonacoNs.IRange => {
    const word = model.getWordUntilPosition(position);
    return {
      startLineNumber: position.lineNumber, startColumn: word.startColumn,
      endLineNumber: position.lineNumber, endColumn: word.endColumn,
    };
  };

  const mapSuggestion = (
    monaco: Monaco, e: CompletionItemDTO, model: MonacoNs.editor.ITextModel,
    position: MonacoNs.Position, file: string,
  ): SuggestionWithMeta => ({
    // Rich label (type/namespace columns) when the server sent labelDetails.
    label: e.labelDetails ? { label: e.label, detail: e.labelDetails.detail, description: e.labelDetails.description } : e.label,
    kind: mapCompletionKind(monaco, e.kind),
    insertText: e.insertText ?? e.label,
    detail: e.detail,
    documentation: e.documentation,
    // Snippet ONLY when the producer declared format 2 — else a literal
    // `${1:..}`/`$1` would be inserted verbatim.
    insertTextRules: e.insertTextFormat === 2
      ? monaco.languages.CompletionItemInsertTextRules.InsertAsSnippet
      : undefined,
    // Preserve the producer's relevance order; without sortText Monaco
    // re-sorts alphabetically and the ranking collapses.
    sortText: e.sortText,
    filterText: e.filterText,
    preselect: e.preselect,
    commitCharacters: e.commitCharacters,
    // Server-chosen replace range is authoritative for `::`/`->` members;
    // fall back to the current word range.
    range: e.textEdit
      ? new monaco.Range(
        e.textEdit.range.start.line, e.textEdit.range.start.column,
        e.textEdit.range.end.line, e.textEdit.range.end.column,
      )
      : wordRange(model, position),
    additionalTextEdits: e.additionalTextEdits ? toEditOps(monaco, e.additionalTextEdits) : undefined,
    _raw: e.raw,
    _file: file,
  });

  // ─── Completion — per-family trigger characters + a '*' fallback for
  // every other language (manual Ctrl+Space). The backend decides which
  // backend answers; registering '*' on top of a specific language would
  // double-call, so the fallback skips covered ids. ───
  const completionProvider: MonacoNs.languages.CompletionItemProvider = {
    async provideCompletionItems(model, position, context) {
      const file = relPath(model);
      const lang = model.getLanguageId();
      try {
        const entries = await apiCall<CompletionItemDTO[]>('lsp.completion', {
          projectId,
          file,
          position: { line: position.lineNumber, column: position.column },
          // Monaco triggerKind (Invoke 0 / TriggerCharacter 1 / Incomplete 2)
          // → LSP (1 / 2 / 3): +1.
          context: { triggerKind: context.triggerKind + 1, triggerCharacter: context.triggerCharacter },
        });
        // Non-TS languages go through the LSP/index race (dumb→smart): mark
        // incomplete so Monaco re-queries each keystroke and picks up the
        // server once it warms (instead of caching the index's first answer).
        // TS/JS are served by the in-process service — only flag big lists.
        const builtin = lang === 'typescript' || lang === 'javascript';
        return {
          suggestions: entries.map((e) => mapSuggestion(monaco, e, model, position, file)),
          incomplete: !builtin || entries.length >= 120,
        };
      } catch {
        return { suggestions: [] };
      }
    },

    // Called by Monaco when an item is focused in the widget — fetch the
    // deferred fields (Intelephense/Pyright attach the use/import edit
    // ONLY here) before the user can accept.
    async resolveCompletionItem(item) {
      const it = item as SuggestionWithMeta;
      if (!it._raw || (it.additionalTextEdits && it.additionalTextEdits.length > 0)) return item;
      try {
        const resolved = await apiCall<CompletionItemDTO | null>('lsp.resolveCompletion', {
          projectId, file: it._file, item: it._raw,
        });
        if (resolved?.additionalTextEdits?.length) {
          it.additionalTextEdits = toEditOps(monaco, resolved.additionalTextEdits);
        }
        if (resolved?.detail && !it.detail) it.detail = resolved.detail;
        if (resolved?.documentation) it.documentation = resolved.documentation;
      } catch { /* keep the unresolved item — completion still inserts */ }
      return item;
    },
  };
  for (const [lang, triggerCharacters] of Object.entries(COMPLETION_TRIGGERS)) {
    disposers.push(
      monaco.languages.registerCompletionItemProvider(lang, {
        triggerCharacters,
        provideCompletionItems: completionProvider.provideCompletionItems.bind(completionProvider),
        resolveCompletionItem: completionProvider.resolveCompletionItem?.bind(completionProvider),
      }),
    );
  }
  disposers.push(
    monaco.languages.registerCompletionItemProvider('*', {
      async provideCompletionItems(model, position, context, token) {
        if (model.getLanguageId() in COMPLETION_TRIGGERS) return { suggestions: [] };
        return completionProvider.provideCompletionItems(
          model, position, context, token,
        ) as MonacoNs.languages.ProviderResult<MonacoNs.languages.CompletionList>;
      },
      resolveCompletionItem: completionProvider.resolveCompletionItem?.bind(completionProvider),
    }),
  );

  // ─── Hover / definition / references — one '*' provider each; the
  // backend router answers for EVERY language (TS service, LSP server or
  // index fallback) ───
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
        } catch {
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
        } catch {
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
        } catch {
          return [];
        }
      },
    }),
  );

  disposers.push(registerEditorOpener(monaco, projectId));

  // AI ghost text — heavily gated (default OFF; see inlineCompletionProvider).
  disposers.push(registerInlineCompletions(monaco, projectId));

  registrations.set(projectId, { disposers });
}

/**
 * Bridge Monaco's "open this URI" intent to the workspace tab store.
 *
 * Without an opener, Ctrl+Click in Monaco gives the model URI to its
 * built-in opener — which assumes a hosted Monaco workbench, not our
 * dashboard. The user sees a flicker and nothing else.
 *
 * Returns `true` to tell Monaco "we handled it". Returns `false` only
 * if the resource isn't a `file:` URI (e.g. clicking through to an
 * `https:` URL — let the browser handle that).
 */
function registerEditorOpener(monaco: Monaco, projectId: number): MonacoNs.IDisposable {
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

  // `registerEditorOpener` arrived in monaco ≥0.34. We're on 0.52, so
  // this is guaranteed present — but guard anyway so a future Monaco
  // downgrade doesn't crash the whole workspace at startup.
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

      // Pull dynamically — the store import path matters for tree-shaking
      // and we don't want lspProvider.ts depending statically on the
      // workspace store (keeps the module reusable in tests).
      const { useWorkspaceStore } = await import('../../../state/workspace.js');
      const store = useWorkspaceStore.getState();
      const existing = store.openFiles.find((f) => f.path === rel && f.projectId === projectId);
      if (existing) {
        store.setActive(rel);
      } else {
        // Open INSTANTLY with content: null — MonacoMount's
        // useEnsureFileContent fetches on activation (no navigation-blocking
        // round trip, no flicker thanks to the loading skeleton).
        store.openFile({
          kind: 'file',
          projectId,
          path: rel,
          content: null,
          dirty: false,
          lastModified: null,
        });
      }

      // Position the cursor at the requested range/position once the
      // editor swap is committed. Monaco re-mounts the editor on tab
      // change, so we wait a tick for the new model to be active.
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

export function unregisterLspProviders(projectId: number): void {
  const reg = registrations.get(projectId);
  if (!reg) return;
  reg.disposers.forEach((d) => d.dispose());
  registrations.delete(projectId);
}
