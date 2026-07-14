/**
 * Context Engine v2 — shared types. The engine assembles prioritized
 * ContextSnippets from independent sources (each time-boxed and fail-open)
 * and packs them into a token budget. Two blocks with different lifetimes:
 *   STABLE   — cross-file knowledge (tabs, edits, defs, imports, siblings),
 *              cached per region so the rendered block stays byte-identical
 *              across keystrokes (provider prompt-cache reuse).
 *   VOLATILE — cursor-bound signal (scope line, receiver members), recomputed
 *              every request and rendered nearest the prefix.
 */
import type { CodeIndexDB } from '@mcp/store/db.js';
import type { PromptWindows } from '../../completion-prompt.js';

export type SnippetKind =
  | 'marker' | 'members' | 'scope'
  | 'recent-edit' | 'lsp-def' | 'open-tab' | 'related-code' | 'siblings' | 'imports';

export interface ContextSnippet {
  kind: SnippetKind;
  /** Project-relative path; '' for marker/scope. */
  filePath: string;
  /** Raw code lines or signature lines (no heading — the renderer adds it). */
  content: string;
  /** Source-local relevance 0..1 (ordering within one source only). */
  score: number;
  tokens: number;
  /** True → never part of the stable-region cache. */
  volatile: boolean;
}

export interface SourceStats {
  n: number;
  tokens: number;
  ms: number;
  timedOut?: boolean;
  error?: boolean;
}

export interface EngineInput {
  db: CodeIndexDB;
  projectId: number;
  file: string;
  language: string;
  windows: PromptWindows;
  position: { line: number; col: number };
  budgetTokens: number;
  /** Per stable source race box. */
  sourceTimeoutMs: number;
  /** Hard cap on the whole stable gather. */
  deadlineMs: number;
  /** Stable-region cache TTL. */
  cacheTtlMs: number;
  /** LSP race for the volatile members source. */
  lspMemberRaceMs: number;
  toggles: { recentEdits: boolean; openTabs: boolean; lspDefs: boolean; relatedCode?: boolean };
  /** Dedicated cap for FTS examples; never allowed to consume the full prompt. */
  relatedCodeTokens?: number;
  jaccardMinScore: number;
  maxTabFiles: number;
}

export type MemberSource = 'lsp' | 'index' | 'none';
export type InferSource = 'lsp' | 'index' | 'local' | 'none';

export interface AssembledContext {
  stable: ContextSnippet[];
  volatile: ContextSnippet[];
  totalTokens: number;
  stableCacheHit: boolean;
  regionKey: string;
  memberSource: MemberSource;
  memberTriggerHit: boolean;
  membersInjected: number;
  inferSource: InferSource;
  sources: Record<string, SourceStats>;
}

/** Cheap token estimate — the budget is a guardrail, not an exact count. */
export function approxTokens(s: string): number {
  return Math.ceil(s.length / 3.5);
}

// Per-source token caps. The packer also clamps to the remaining budget.
export const MEMBERS_CAP_TOK = 250;
export const SCOPE_CAP_TOK = 50;
export const EDITS_CAP_TOK = 600;
export const LSPDEF_CAP_TOK = 500;
export const TABS_CAP_TOK = 900;
export const SIBLINGS_CAP_TOK = 200;
export const IMPORTS_CAP_TOK = 250;
/** Approx tokens a snippet heading/separator adds when rendered. */
export const SNIPPET_OVERHEAD_TOK = 8;
