/**
 * In-process LspBackendExecutor — the synchronous compute moved verbatim
 * out of the lsp router (index.ts). Runs in two places:
 *
 *   - main thread: kill-switch (`MCP_LSP_WORKER=0`) and per-call fallback
 *     when the worker is unavailable — identical to pre-worker behavior.
 *   - lsp worker_thread: the normal desktop path. Same module; `getDoc`
 *     reads that thread's document-store instance (the mirror), which the
 *     worker entry keeps fed via doc.* events.
 *
 * Every op syncs the live buffer into the TS service AT USE TIME (the old
 * eager sync on didOpen/didChange was redundant — each op re-synced anyway).
 */
import type { CodeIndexDB } from '@mcp/store/db.js';
import { getTsService } from '@mcp/code-agent/lsp/ts-service.js';
import { getDoc } from './document-store.js';
import {
  fallbackCompletion,
  fallbackDefinition,
  fallbackHover,
  fallbackReferences,
} from './index-fallback.js';
import type { LspBackendExecutor, LspOpCtx } from './executor-types.js';

function requirePosition(ctx: LspOpCtx): { line: number; column: number } {
  if (!ctx.position) throw new Error(`lsp op on ${ctx.file}: position required`);
  return ctx.position;
}

function requireRange(ctx: LspOpCtx): NonNullable<LspOpCtx['range']> {
  if (!ctx.range) throw new Error(`lsp op on ${ctx.file}: range required`);
  return ctx.range;
}

/** Live buffer: explicit content (legacy callers) > document store > disk (backend reads). */
function liveContent(ctx: LspOpCtx): string | undefined {
  return ctx.content ?? getDoc(ctx.projectId, ctx.file)?.content;
}

/** Push the buffer into the TS service before computing. Best-effort. */
function syncTs(ctx: LspOpCtx): void {
  const text = liveContent(ctx);
  if (text === undefined) return;
  try {
    getTsService(ctx.root).setFileSnapshot(ctx.file, text);
  } catch {
    /* still try the call — the service falls back to disk content */
  }
}

export function createInProcessLspExecutor(db: CodeIndexDB): LspBackendExecutor {
  return {
    async tsCompletions(ctx) {
      const pos = requirePosition(ctx);
      syncTs(ctx);
      return getTsService(ctx.root).getCompletions(ctx.file, pos.line, pos.column);
    },

    async tsCompletionDetails(ctx) {
      const pos = requirePosition(ctx);
      const entry = ctx.completionEntry;
      if (!entry) return null;
      syncTs(ctx);
      return getTsService(ctx.root).getCompletionDetails(
        ctx.file, pos.line, pos.column, entry.name, entry.source, entry.data,
      );
    },

    async tsHover(ctx) {
      const pos = requirePosition(ctx);
      syncTs(ctx);
      return getTsService(ctx.root).getHover(ctx.file, pos.line, pos.column);
    },

    async tsDefinition(ctx) {
      const pos = requirePosition(ctx);
      syncTs(ctx);
      return getTsService(ctx.root).getDefinition(ctx.file, pos.line, pos.column);
    },

    async tsReferences(ctx) {
      const pos = requirePosition(ctx);
      syncTs(ctx);
      return getTsService(ctx.root).getReferences(ctx.file, pos.line, pos.column);
    },

    async tsDiagnostics(ctx) {
      syncTs(ctx);
      return getTsService(ctx.root).getDiagnostics(ctx.file);
    },

    async tsSemanticTokens(ctx) {
      syncTs(ctx);
      return getTsService(ctx.root).getSemanticTokens(ctx.file);
    },

    async tsCodeActions(ctx) {
      syncTs(ctx);
      return getTsService(ctx.root).getCodeActions(ctx.file, requireRange(ctx));
    },

    async tsRename(ctx) {
      const pos = requirePosition(ctx);
      if (!ctx.newName) throw new Error(`lsp op on ${ctx.file}: newName required`);
      syncTs(ctx);
      return getTsService(ctx.root).getRenameEdits(ctx.file, pos.line, pos.column, ctx.newName);
    },

    async tsSignatureHelp(ctx) {
      const pos = requirePosition(ctx);
      syncTs(ctx);
      return getTsService(ctx.root).getSignatureHelp(ctx.file, pos.line, pos.column);
    },

    async tsDocumentSymbols(ctx) {
      syncTs(ctx);
      return getTsService(ctx.root).getDocumentSymbols(ctx.file);
    },

    async fallbackCompletion(ctx) {
      return fallbackCompletion(db, ctx.projectId, ctx.root, ctx.file, requirePosition(ctx), ctx.languageId);
    },

    async fallbackDefinition(ctx) {
      return fallbackDefinition(db, ctx.projectId, ctx.root, ctx.file, requirePosition(ctx));
    },

    async fallbackHover(ctx) {
      return fallbackHover(
        db, ctx.projectId, ctx.root, ctx.file, requirePosition(ctx), ctx.languageId ?? 'plaintext',
      );
    },

    async fallbackReferences(ctx) {
      return fallbackReferences(db, ctx.projectId, ctx.root, ctx.file, requirePosition(ctx));
    },
  };
}
