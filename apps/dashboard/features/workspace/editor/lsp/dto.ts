/**
 * DTOs + helpers puros compartilhados pelos providers LSP do Monaco
 * (extraído de lspProvider.ts — W4 decompose). Sem closures, sem estado.
 */
import type * as MonacoNs from 'monaco-editor';
import { parseModelPath } from '../editor-models-path.js';

export type Monaco = typeof MonacoNs;

/** Trigger characters per language family; '*' (manual Ctrl+Space) covers the rest. */
export const COMPLETION_TRIGGERS: Record<string, string[]> = {
  typescript: ['.', '"', "'", '/', '@', '<', '#'],
  javascript: ['.', '"', "'", '/', '@', '<', '#'],
  php: ['$', '>', ':', '\\'],
  python: ['.'],
};

export interface Position {
  line: number;
  column: number;
}

export interface CompletionItemDTO {
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
  insertReplaceEdit?: { insert: { start: Position; end: Position }; replace: { start: Position; end: Position }; newText: string };
  deprecated?: boolean;
  tags?: number[];
  origin?: 'ts' | 'lsp' | 'index';
}

export interface CompletionListDTO { items: CompletionItemDTO[]; isIncomplete: boolean }

/** Our suggestion carries the opaque LSP item + file for lazy resolve. */
export type SuggestionWithMeta = MonacoNs.languages.CompletionItem & {
  _raw?: unknown;
  _file?: string;
};

export interface HoverDTO {
  contents: string;
  range?: { start: Position; end: Position };
}

export interface LspLocationDTO {
  file: string;
  range: { start: Position; end: Position };
}

export interface TextEditDTO {
  range: { start: Position; end: Position };
  newText: string;
}

export interface WorkspaceEditDTO {
  changes: Record<string, TextEditDTO[]>;
}

export interface CodeActionDTO {
  title: string;
  kind: string;
  isPreferred?: boolean;
  edit?: WorkspaceEditDTO;
  command?: { command: string; arguments?: unknown[] };
  originServerId?: string;
  raw?: unknown;
  needsResolve?: boolean;
}

export function toEditOps(
  monaco: Monaco,
  edits: NonNullable<CompletionItemDTO['additionalTextEdits']>,
): MonacoNs.editor.ISingleEditOperation[] {
  return edits.map((e) => ({
    range: new monaco.Range(e.range.start.line, e.range.start.column, e.range.end.line, e.range.end.column),
    text: e.newText,
  }));
}

export function toMonacoRange(monaco: Monaco, r: { start: Position; end: Position }): MonacoNs.IRange {
  return new monaco.Range(r.start.line, r.start.column, r.end.line, r.end.column);
}

export function toWorkspaceEdit(monaco: Monaco, edit?: WorkspaceEditDTO): MonacoNs.languages.WorkspaceEdit | undefined {
  if (!edit) return undefined;
  const edits: MonacoNs.languages.WorkspaceEdit['edits'] = [];
  for (const [file, fileEdits] of Object.entries(edit.changes)) {
    const resource = monaco.Uri.file(file);
    for (const e of fileEdits) {
      edits.push({
        resource,
        textEdit: {
          range: toMonacoRange(monaco, e.range),
          text: e.newText,
        },
        versionId: undefined,
      });
    }
  }
  return { edits };
}

export function mapCompletionKind(monaco: Monaco, kind: string): MonacoNs.languages.CompletionItemKind {
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

/** Strip do prefixo de namespacing por projectId (W1b) → relpath limpo p/ o backend. */
export function relPath(model: MonacoNs.editor.ITextModel): string {
  return parseModelPath(model.uri.path).relPath;
}
