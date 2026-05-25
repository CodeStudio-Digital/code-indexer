/**
 * Wire the @mcp/api-bus lsp.* methods into Monaco's provider registry.
 *
 * Registered providers (TS/JS only for MVP — other languages get
 * Monaco's built-in syntax highlight but no IntelliSense):
 *   - completion (debounced 300 ms via Monaco's trigger system)
 *   - hover
 *   - definition (Ctrl+Click)
 *   - references
 *   - diagnostics (polled per active model, 1s, scoped to current file)
 *
 * Registration is idempotent per projectId — calling it multiple times
 * with the same projectId is a no-op. Switching projects (rare in
 * Workspace mode) tears down the old providers and re-registers.
 *
 * Latency target: <300 ms p95 for completion. apiCall uses Electron IPC
 * when available (sub-millisecond bridge cost) or HTTP fallback. In-process
 * LSP service is already plenty fast; pushing to a worker thread (Dia 8
 * pool) lands when we hit a project size where the main-thread block
 * matters.
 */

import type * as MonacoNs from 'monaco-editor';
import { apiCall } from '../../../lib/api-client.js';

type Monaco = typeof MonacoNs;

const SUPPORTED_LANGUAGES = ['typescript', 'javascript'];
const TRIGGER_CHARACTERS = ['.', '"', "'", '/', '@', '<', '#'];

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
  insertText?: string;
}

interface HoverDTO {
  contents: string;
  range?: { start: Position; end: Position };
}

interface LspLocationDTO {
  file: string;
  range: { start: Position; end: Position };
}

interface DiagnosticDTO {
  file: string;
  range: { start: Position; end: Position };
  severity: 'error' | 'warning' | 'info' | 'hint';
  message: string;
  source?: string;
  code?: string | number;
}

function toMonacoRange(monaco: Monaco, r: { start: Position; end: Position }): MonacoNs.IRange {
  return new monaco.Range(r.start.line, r.start.column, r.end.line, r.end.column);
}

function mapCompletionKind(monaco: Monaco, kind: string): MonacoNs.languages.CompletionItemKind {
  // Monaco's enum is a superset of TS's `ScriptElementKind`. Map the
  // common ones; the rest fall through to `Text` which renders fine.
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
    case 'parameter': return k.Variable;
    case 'class': return k.Class;
    case 'interface': return k.Interface;
    case 'enum': return k.Enum;
    case 'enum member': return k.EnumMember;
    case 'module': return k.Module;
    case 'keyword': return k.Keyword;
    case 'type parameter': return k.TypeParameter;
    default: return k.Text;
  }
}

function mapSeverity(monaco: Monaco, sev: DiagnosticDTO['severity']): MonacoNs.MarkerSeverity {
  const s = monaco.MarkerSeverity;
  switch (sev) {
    case 'error': return s.Error;
    case 'warning': return s.Warning;
    case 'info': return s.Info;
    case 'hint': return s.Hint;
  }
}

/**
 * Walk every TS/JS model that belongs to the active project and refresh
 * its diagnostics via `lsp.diagnostics`. Uses a 1 s polling interval —
 * plenty for "show me red squigglies a moment after I stop typing"
 * without paying for a per-model `onDidChangeContent` listener.
 *
 * Earlier attempt called `monaco.editor.onDidChangeModelContent`, which
 * doesn't exist on the editor namespace — that method only lives on
 * `IStandaloneCodeEditor` instances. The polling approach also handles
 * external file changes (writing through the agent or via files.write)
 * without extra plumbing.
 */
function startDiagnosticsLoop(monaco: Monaco, projectId: number): MonacoNs.IDisposable {
  let stopped = false;
  let inflight = 0;

  async function refresh(model: MonacoNs.editor.ITextModel) {
    if (stopped) return;
    if (!SUPPORTED_LANGUAGES.includes(model.getLanguageId())) return;
    const path = model.uri.path.replace(/^\//, '');
    inflight += 1;
    try {
      const diags = await apiCall<DiagnosticDTO[]>('lsp.diagnostics', {
        projectId,
        file: path,
        // Diagnostics run on a 1s poll — passing the live model text
        // every tick is what keeps red squigglies in sync with what
        // the user actually typed (vs the last-saved disk content).
        content: model.getValue(),
      });
      if (stopped) return;
      monaco.editor.setModelMarkers(
        model,
        'mcp-lsp',
        diags.map((d) => ({
          severity: mapSeverity(monaco, d.severity),
          message: d.message,
          startLineNumber: d.range.start.line,
          startColumn: d.range.start.column,
          endLineNumber: Math.max(d.range.start.line, d.range.end.line),
          endColumn: Math.max(d.range.start.column, d.range.end.column),
          source: d.source ?? 'ts',
          code: d.code != null ? String(d.code) : undefined,
        })),
      );
    } catch {
      /* swallow — diagnostics are best-effort */
    } finally {
      inflight -= 1;
    }
  }

  const timer = setInterval(() => {
    if (inflight > 2) return; // backpressure
    for (const model of monaco.editor.getModels()) {
      void refresh(model);
    }
  }, 1000);

  return {
    dispose() {
      stopped = true;
      clearInterval(timer);
    },
  };
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

  // ─── Semantic token provider ────────────────────────────────────
  //
  // Monaco's built-in TS worker can't classify symbols correctly
  // because it doesn't know the user's project (no tsconfig, no
  // node_modules). Without semantic tokens, `this.router` is just
  // a plain identifier — same colour as a local variable.
  //
  // Our LSP HAS the project context (real tsconfig, real
  // node_modules walk via the TS Compiler API). It returns proper
  // classifications (`property` for `.router`, `type` for `Router`,
  // `method` for `.navigate`, etc.) which Monaco's default themes
  // already have colour rules for — we get correct colours for free.
  //
  // The legend below MUST match the indices emitted by the backend's
  // `getSemanticTokens` (see SEMANTIC_TOKEN_TYPES / MODIFIERS in
  // ts-service.ts).
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
  for (const lang of SUPPORTED_LANGUAGES) {
    disposers.push(
      monaco.languages.registerDocumentSemanticTokensProvider(lang, {
        getLegend: () => SEMANTIC_TOKEN_LEGEND,
        async provideDocumentSemanticTokens(model) {
          const path = model.uri.path;
          try {
            const result = await apiCall<{ data: number[]; resultId?: string }>(
              'lsp.semanticTokens',
              {
                projectId,
                file: path,
                content: model.getValue(),
              },
            );
            return {
              data: new Uint32Array(result.data),
              resultId: result.resultId,
            };
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

  for (const lang of SUPPORTED_LANGUAGES) {
    disposers.push(
      monaco.languages.registerCompletionItemProvider(lang, {
        triggerCharacters: TRIGGER_CHARACTERS,
        async provideCompletionItems(model, position) {
          const path = model.uri.path.replace(/^\//, '');
          const word = model.getWordUntilPosition(position);
          try {
            const entries = await apiCall<CompletionItemDTO[]>('lsp.completion', {
              projectId,
              file: path,
              position: { line: position.lineNumber, column: position.column },
              // Live buffer — without this the backend reads the file
              // from disk and misses unsaved keystrokes (e.g. the `.`
              // that triggered this very completion).
              content: model.getValue(),
            });
            return {
              suggestions: entries.map((e) => ({
                label: e.label,
                kind: mapCompletionKind(monaco, e.kind),
                insertText: e.insertText ?? e.label,
                detail: e.detail,
                range: {
                  startLineNumber: position.lineNumber,
                  startColumn: word.startColumn,
                  endLineNumber: position.lineNumber,
                  endColumn: word.endColumn,
                },
              })),
            };
          } catch {
            return { suggestions: [] };
          }
        },
      }),
    );

    disposers.push(
      monaco.languages.registerHoverProvider(lang, {
        async provideHover(model, position) {
          const path = model.uri.path.replace(/^\//, '');
          try {
            const hover = await apiCall<HoverDTO | null>('lsp.hover', {
              projectId,
              file: path,
              position: { line: position.lineNumber, column: position.column },
              content: model.getValue(),
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
      monaco.languages.registerDefinitionProvider(lang, {
        async provideDefinition(model, position) {
          // Backend tsCanonical normalises whatever we send (`/D:/...`,
          // `D:\\...`, relative), so we hand it the raw model path.
          const path = model.uri.path;
          try {
            const locs = await apiCall<LspLocationDTO[]>('lsp.definition', {
              projectId,
              file: path,
              position: { line: position.lineNumber, column: position.column },
              content: model.getValue(),
            });
            return locs.map((loc) => ({
              // monaco.Uri.file expects an absolute filesystem path. The
              // backend returns absolute canonical paths (`d:/MCP/foo.ts`
              // on Windows) precisely so this call round-trips and Monaco
              // can match against the open model — or open a new one via
              // the editor opener if the target file isn't in a tab yet.
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
      monaco.languages.registerReferenceProvider(lang, {
        async provideReferences(model, position) {
          const path = model.uri.path;
          try {
            const locs = await apiCall<LspLocationDTO[]>('lsp.references', {
              projectId,
              file: path,
              position: { line: position.lineNumber, column: position.column },
              content: model.getValue(),
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
  }

  disposers.push(startDiagnosticsLoop(monaco, projectId));
  disposers.push(registerWeakDefinitionProvider(monaco, projectId));
  disposers.push(registerEditorOpener(monaco, projectId));

  registrations.set(projectId, { disposers });
}

/**
 * Bridge Monaco's "open this URI" intent to the workspace tab store.
 *
 * Without an opener, Ctrl+Click in Monaco gives the model URI to its
 * built-in opener — which assumes a hosted Monaco workbench, not our
 * dashboard. The user sees a flicker and nothing else.
 *
 * Our opener:
 *   1. Receives `resource` = `file:///d:/MCP/apps/dashboard/foo.ts`
 *   2. Looks up the project's root_path (cached) to strip the prefix
 *   3. Computes the project-relative path Monaco models are keyed by
 *   4. Pushes onto the workspace store via openFile + fetches content
 *      asynchronously — by the time the user blinks, MonacoMount has
 *      swapped to the new tab.
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
        // Fetch content first so MonacoMount has it on mount — saves a
        // visible flicker between "empty model" and "file loaded".
        try {
          const file = await apiCall<{ content: string; last_modified: string }>('files.read', {
            projectId,
            path: rel,
          });
          store.openFile({
            kind: 'file',
            projectId,
            path: rel,
            content: file.content,
            dirty: false,
            lastModified: file.last_modified,
          });
        } catch {
          // Read failed (file gone? permissions?). Fall back to opening
          // an empty tab — better than swallowing the navigation.
          store.openFile({
            kind: 'file',
            projectId,
            path: rel,
            content: '',
            dirty: false,
            lastModified: null,
          });
        }
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

/**
 * Fallback "go to definition" for languages that don't have an LSP yet
 * (PHP, Java, C#, Python, Go, …). When the user Ctrl/Cmd+Clicks a word,
 * we ask the indexer to grep the codebase for that symbol and offer up
 * to a handful of matches — better than the current Monaco no-op.
 *
 * Registered as a `*` language provider AFTER the TS/JS-specific ones,
 * so for supported languages the real LSP still wins (Monaco merges
 * provider results — the LSP responses are richer + accurate).
 *
 * Path resolution: `search.project` returns `file_path` relative to the
 * project root. Monaco needs an absolute URI to either match an open
 * model or open a new tab via the editor opener. We fetch the project
 * root once at registration and construct `monaco.Uri.file(rootJoin)`.
 */
function registerWeakDefinitionProvider(monaco: Monaco, projectId: number): MonacoNs.IDisposable {
  // Cache the project root the first time we need it. Failures are
  // tolerated — the worst case is "no weak fallback for this projectId".
  let projectRoot: string | null = null;
  const ensureRoot = async (): Promise<string | null> => {
    if (projectRoot !== null) return projectRoot;
    try {
      const project = await apiCall<{ root_path?: string }>('projects.get', { id: projectId });
      if (project?.root_path) projectRoot = project.root_path;
    } catch {
      /* keep null; fallback degrades to "no results" instead of crashing */
    }
    return projectRoot;
  };

  function joinAbs(root: string, rel: string): string {
    // Strip leading "./" and any leading slash so the join doesn't
    // double-up separators. Use forward slashes throughout — Monaco
    // accepts both but consistency makes the URIs grep-friendly.
    const cleaned = rel.replace(/^\.\//, '').replace(/^[/\\]+/, '');
    const rootFwd = root.replace(/\\/g, '/').replace(/\/$/, '');
    return `${rootFwd}/${cleaned.replace(/\\/g, '/')}`;
  }

  return monaco.languages.registerDefinitionProvider('*', {
    async provideDefinition(model, position) {
      const word = model.getWordAtPosition(position);
      if (!word || word.word.length < 2) return [];
      // Skip the symbol-search hop for languages we already covered
      // properly above — TS/JS responses there are exact.
      if (SUPPORTED_LANGUAGES.includes(model.getLanguageId())) return [];
      const root = await ensureRoot();
      if (!root) return [];
      try {
        const r = await apiCall<{ results: Array<{ file_path: string; line?: number; name?: string }> }>(
          'search.project',
          {
            projectId,
            query: word.word,
            mode: 'hybrid',
            type: 'symbols',
            limit: 8,
          },
        );
        const candidates = r.results ?? [];
        // Bias matches whose name === the clicked word; rest come after.
        candidates.sort((a, b) => {
          const ax = a.name === word.word ? 0 : 1;
          const bx = b.name === word.word ? 0 : 1;
          return ax - bx;
        });
        return candidates.slice(0, 5).map((m) => ({
          uri: monaco.Uri.file(joinAbs(root, m.file_path)),
          range: new monaco.Range(
            Math.max(1, m.line ?? 1),
            1,
            Math.max(1, m.line ?? 1),
            1 + word.word.length,
          ),
        }));
      } catch {
        return [];
      }
    },
  });
}

export function unregisterLspProviders(projectId: number): void {
  const reg = registrations.get(projectId);
  if (!reg) return;
  reg.disposers.forEach((d) => d.dispose());
  registrations.delete(projectId);
}
