/**
 * LspBackendExecutor — the synchronous language-compute surface extracted
 * from the lsp router. The SAME implementation (executor-inproc.ts) runs
 * either on the main thread (kill-switch / worker-unavailable fallback) or
 * inside the dedicated lsp worker_thread, so behavior is identical by
 * construction; only the thread changes.
 */
import type { CodeActionDTO, CompletionItem, DocChange, HoverInfo, LspLocation } from '@mcp/api-bus';
import type {
  CompletionEntry,
  CompletionDetails,
  DefinitionResult,
  DiagnosticResult,
  HoverResult,
  ReferenceResult,
} from '@mcp/code-agent/lsp/ts-service.js';

export interface LspOpCtx {
  projectId: number;
  /** Project root, resolved on the main thread (requireProjectRoot). */
  root: string;
  /** Project-relative path — the editor's model key. */
  file: string;
  position?: { line: number; column: number };
  range?: { start: { line: number; column: number }; end: { line: number; column: number } };
  /** Explicit content from legacy callers (HTTP compat, agent tools). */
  content?: string;
  /** Language id for ops that render language-aware output (fallbackHover). */
  languageId?: string;
  /**
   * Document-store version at dispatch time. The worker compares it against
   * its mirror and answers the stale sentinel when the mirror lags (lost
   * doc events across an evict/respawn) — the client resyncs and retries.
   */
  docVersion?: number;
  /** completionItem/resolve (TS auto-import): a entry escolhida + seu source/data opacos. */
  completionEntry?: { name: string; source?: string; data?: unknown };
}

export interface LspBackendExecutor {
  // TS service ops — raw ts-service shapes; the router keeps the DTO maps.
  tsCompletions(ctx: LspOpCtx): Promise<CompletionEntry[]>;
  /** Auto-import resolve (TS/JS): ctx.completionEntry + ctx.position → import edits. */
  tsCompletionDetails(ctx: LspOpCtx): Promise<CompletionDetails | null>;
  tsHover(ctx: LspOpCtx): Promise<HoverResult | null>;
  tsDefinition(ctx: LspOpCtx): Promise<DefinitionResult>;
  tsReferences(ctx: LspOpCtx): Promise<ReferenceResult>;
  tsDiagnostics(ctx: LspOpCtx): Promise<DiagnosticResult[]>;
  tsSemanticTokens(ctx: LspOpCtx): Promise<number[]>;
  tsCodeActions(ctx: LspOpCtx): Promise<CodeActionDTO[]>;
  // Structural-index fallback ops — these already return wire DTOs.
  fallbackCompletion(ctx: LspOpCtx): Promise<CompletionItem[]>;
  fallbackDefinition(ctx: LspOpCtx): Promise<LspLocation[]>;
  fallbackHover(ctx: LspOpCtx): Promise<HoverInfo | null>;
  fallbackReferences(ctx: LspOpCtx): Promise<LspLocation[]>;
}

export type LspExecutorOp = keyof LspBackendExecutor;

/**
 * Timeout policy: a slow op answers EMPTY, never re-runs synchronously on
 * the main thread (that would reintroduce the exact stall the worker
 * exists to remove). Editor surfaces tolerate empty answers natively.
 */
export const EMPTY_RESULTS: Record<LspExecutorOp, unknown> = {
  tsCompletions: [],
  tsCompletionDetails: null,
  tsHover: null,
  tsDefinition: { targets: [] },
  tsReferences: { references: [] },
  tsDiagnostics: [],
  tsSemanticTokens: [],
  tsCodeActions: [],
  fallbackCompletion: [],
  fallbackDefinition: [],
  fallbackHover: null,
  fallbackReferences: [],
};

// ── Wire shapes (main ↔ lsp-worker over MessageBridge) ────────────────────

/** Request payload for the single 'lsp.call' bridge handler. */
export interface LspCallPayload {
  op: LspExecutorOp;
  ctx: LspOpCtx;
}

/** Worker answer when its doc mirror lags ctx.docVersion. */
export interface LspStaleSentinel {
  __stale: true;
}

export function isStaleSentinel(value: unknown): value is LspStaleSentinel {
  return typeof value === 'object' && value !== null && (value as LspStaleSentinel).__stale === true;
}

/** Doc-sync mirror events (main → worker, fire-and-forget, FIFO port). */
export interface DocOpenEvent {
  projectId: number;
  file: string;
  languageId: string;
  version: number;
  content: string;
}

export interface DocChangeEvent {
  projectId: number;
  file: string;
  version: number;
  changes: DocChange[];
}

export interface DocCloseEvent {
  projectId: number;
  file: string;
}
