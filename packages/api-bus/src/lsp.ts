import type { ApiContext } from './common.js';

/**
 * LSP-style operations backed by the TypeScript Compiler API in-process.
 * Source: packages/code-agent/src/lsp/ts-service.ts. Delegates to the
 * lsp-worker (kind='lsp' in the worker pool) when the IDE editor calls
 * one of these on every keystroke (debounced).
 *
 * MVP: only .ts / .tsx / .js / .jsx are fully supported. Other languages
 * get Monaco built-in syntax highlight but no completion/hover/etc.
 *
 * Routes mapped: NEW — apps/http-api/server/routes/lsp/lsp.routes.ts
 * (created in Dia 10).
 */

export interface Position {
  /** 1-based, matching ts-service.ts contract. */
  line: number;
  column: number;
}

export interface LspLocation {
  file: string;
  range: { start: Position; end: Position };
}

export interface CompletionItem {
  label: string;
  kind: string;
  detail?: string;
  documentation?: string;
  insertText?: string;
}

export interface HoverInfo {
  contents: string;
  range?: { start: Position; end: Position };
}

export interface DiagnosticItem {
  file: string;
  range: { start: Position; end: Position };
  severity: 'error' | 'warning' | 'info' | 'hint';
  message: string;
  source?: string;
  code?: string | number;
}

/**
 * All position-based LSP calls accept an optional `content` carrying the
 * EDITOR'S live model text. When present, the backend snapshots it into
 * the TS Compiler API's host BEFORE computing — without this, completion
 * / hover / diagnostics read the on-disk version and miss whatever the
 * user just typed (the canonical bug: typing `this.router.` produced no
 * suggestions because the dot wasn't saved yet). The renderer should
 * pass `model.getValue()` for the file it's querying. Other files'
 * snapshots stay disk-backed and only refresh when their tab is active
 * and queried.
 */
export interface LspApi {
  completion(
    input: { projectId: number; file: string; position: Position; content?: string },
    ctx: ApiContext,
  ): Promise<CompletionItem[]>;

  hover(
    input: { projectId: number; file: string; position: Position; content?: string },
    ctx: ApiContext,
  ): Promise<HoverInfo | null>;

  definition(
    input: { projectId: number; file: string; position: Position; content?: string },
    ctx: ApiContext,
  ): Promise<LspLocation[]>;

  references(
    input: { projectId: number; file: string; position: Position; content?: string },
    ctx: ApiContext,
  ): Promise<LspLocation[]>;

  diagnostics(
    input: { projectId: number; file?: string; content?: string },
    ctx: ApiContext,
  ): Promise<DiagnosticItem[]>;

  /**
   * Semantic-token classifications for syntax highlighting. The TS
   * Compiler API tags every identifier in the file as class /
   * interface / property / method / parameter / etc. — the renderer
   * maps those to Monaco's semantic-token registry so themes can colour
   * them distinctly (e.g. `this.router` reads as a property, not as
   * a plain identifier).
   *
   * Returned `data` is the LSP-style delta-encoded array Monaco
   * consumes via `registerDocumentSemanticTokensProvider`:
   *   [ deltaLine, deltaStart, length, tokenType, tokenModifiers,
   *     deltaLine, deltaStart, length, tokenType, tokenModifiers, … ]
   *
   * Token type / modifier indices reference the legend the renderer
   * declares on registration — see `lspProvider.ts`.
   */
  semanticTokens(
    input: { projectId: number; file: string; content?: string },
    ctx: ApiContext,
  ): Promise<{ data: number[]; resultId?: string }>;

  rename(
    input: { projectId: number; file: string; position: Position; newName: string },
    ctx: ApiContext,
  ): Promise<{ edits: Array<{ file: string; range: { start: Position; end: Position }; newText: string }> }>;

  codeActions(
    input: { projectId: number; file: string; range: { start: Position; end: Position } },
    ctx: ApiContext,
  ): Promise<Array<{ title: string; kind: string; edits?: unknown }>>;
}
