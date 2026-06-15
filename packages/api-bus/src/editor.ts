import type { ApiContext } from './common.js';

/**
 * Editor AI services — inline autocomplete (ghost text).
 *
 * Backed by the `editor/autocomplete` pipeline binding (admin-configured).
 * No binding → every call answers `{ status: 'unconfigured' }` cheaply and
 * the client snoozes; nothing is ever sent to a provider without a binding.
 * Source: packages/api-handlers/src/editor/.
 */

export type EditorCompleteStatus =
  | 'ok'
  | 'empty'
  | 'unconfigured'
  | 'timeout'
  | 'provider_error';

export interface EditorCompleteInput {
  projectId: number;
  /** Project-relative path (same key as LSP/doc-sync). */
  file: string;
  /** Monaco language id (e.g. 'typescript', 'php'). */
  language: string;
  /** 1-based line / 1-based column of the cursor. */
  position: { line: number; col: number };
  /** Text before the cursor (client pre-trims to a window). */
  prefix: string;
  /** Text after the cursor (client pre-trims to a window). */
  suffix: string;
}

export interface EditorCompleteResult {
  status: EditorCompleteStatus;
  /** Present when status==='ok' — raw code to ghost-insert at the cursor. */
  text?: string;
  /** Server-suggested debounce (binding config) — client adopts it. */
  debounceMs?: number;
  /** Correlates accept feedback with the completion request. */
  requestId?: string;
  /** Short diagnostic for provider_error (never the raw provider body). */
  message?: string;
  /** Suggested snooze on provider errors (rate-limit aware). */
  retryAfterMs?: number;
}

export interface EditorApi {
  /**
   * One inline-completion request. Single-flight per (projectId,file) on
   * the server — a newer call aborts the in-flight provider request.
   */
  complete(input: EditorCompleteInput, ctx: ApiContext): Promise<EditorCompleteResult>;

  /** Fire-and-forget accept signal (telemetry: accept-rate per binding). */
  feedback(
    input: { projectId: number; requestId: string; action: 'accept' },
    ctx: ApiContext,
  ): Promise<{ ok: boolean }>;
}
