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
      const diags = await apiCall<DiagnosticDTO[]>('lsp.diagnostics', { projectId, file: path });
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
          const path = model.uri.path.replace(/^\//, '');
          try {
            const locs = await apiCall<LspLocationDTO[]>('lsp.definition', {
              projectId,
              file: path,
              position: { line: position.lineNumber, column: position.column },
            });
            return locs.map((loc) => ({
              uri: monaco.Uri.parse(loc.file),
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
          const path = model.uri.path.replace(/^\//, '');
          try {
            const locs = await apiCall<LspLocationDTO[]>('lsp.references', {
              projectId,
              file: path,
              position: { line: position.lineNumber, column: position.column },
            });
            return locs.map((loc) => ({
              uri: monaco.Uri.parse(loc.file),
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

  registrations.set(projectId, { disposers });
}

export function unregisterLspProviders(projectId: number): void {
  const reg = registrations.get(projectId);
  if (!reg) return;
  reg.disposers.forEach((d) => d.dispose());
  registrations.delete(projectId);
}
