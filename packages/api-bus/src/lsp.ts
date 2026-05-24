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

export interface LspApi {
  completion(
    input: { projectId: number; file: string; position: Position },
    ctx: ApiContext,
  ): Promise<CompletionItem[]>;

  hover(
    input: { projectId: number; file: string; position: Position },
    ctx: ApiContext,
  ): Promise<HoverInfo | null>;

  definition(
    input: { projectId: number; file: string; position: Position },
    ctx: ApiContext,
  ): Promise<LspLocation[]>;

  references(
    input: { projectId: number; file: string; position: Position },
    ctx: ApiContext,
  ): Promise<LspLocation[]>;

  diagnostics(
    input: { projectId: number; file?: string },
    ctx: ApiContext,
  ): Promise<DiagnosticItem[]>;

  rename(
    input: { projectId: number; file: string; position: Position; newName: string },
    ctx: ApiContext,
  ): Promise<{ edits: Array<{ file: string; range: { start: Position; end: Position }; newText: string }> }>;

  codeActions(
    input: { projectId: number; file: string; range: { start: Position; end: Position } },
    ctx: ApiContext,
  ): Promise<Array<{ title: string; kind: string; edits?: unknown }>>;
}
