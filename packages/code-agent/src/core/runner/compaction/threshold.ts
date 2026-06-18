/**
 * Single-source compaction threshold. Replaces the multi-branch
 * `computeCompactionTrigger` in `compaction/limits.ts` with one rule:
 * fire compaction when the last known prompt-token count crosses
 * `triggerRatio` (default 90%) of the model's effective context window.
 *
 * Effective window comes from `deriveTokenLimits(model)` — the same helper
 * the legacy path uses, so the new and old paths agree on what "effective"
 * means while both still exist.
 */
import {
  DEFAULT_COMPACT_TRIGGER_RATIO,
  deriveTokenLimits,
  resolveTriggerRatio,
} from '@mcp/code-agent/core/compaction/limits.js';

export interface CompactionThresholdInputs {
  /** Last known prompt-token count from the provider response. */
  promptTokens: number;
  /** Model id — used to look up the effective context window. */
  model: string;
  /**
   * Ratio at which compaction fires, expressed as a fraction of the
   * effective context window. Default 0.90.
   */
  triggerRatio?: number;
}

export interface CompactionThresholdDecision {
  shouldCompact: boolean;
  /** Fraction `promptTokens / effective`. Useful for telemetry. */
  ratio: number;
  promptTokens: number;
  effective: number;
}

/**
 * História do ratio: 0.90 → 0.75 (Frente B) → 0.70 (Fix B, sessão 887) →
 * **0.90 de novo** por decisão do operador: 0.70 desperdiçava ~30% da janela
 * resumindo cedo demais, e a continuidade pós-resumo agora é carregada pelo
 * estado vivo da sessão + memória durável injetados, não por uma cauda longa.
 * O valor é o knob único `resolveTriggerRatio()` (env
 * `CODER_COMPACT_TRIGGER_RATIO`, clamp 0.50–0.95) — também dirige o gate de
 * body (ratio − 0.05) e o backstop token-budget de `deriveTokenLimits`.
 */
export const DEFAULT_TRIGGER_RATIO = DEFAULT_COMPACT_TRIGGER_RATIO;
export { resolveTriggerRatio };

export function shouldCompact90(inp: CompactionThresholdInputs): CompactionThresholdDecision {
  const limits = deriveTokenLimits(inp.model);
  const triggerRatio = inp.triggerRatio ?? resolveTriggerRatio();
  if (limits.effective <= 0 || inp.promptTokens <= 0) {
    return {
      shouldCompact: false,
      ratio: 0,
      promptTokens: inp.promptTokens,
      effective: limits.effective,
    };
  }
  const ratio = inp.promptTokens / limits.effective;
  return {
    shouldCompact: ratio >= triggerRatio,
    ratio,
    promptTokens: inp.promptTokens,
    effective: limits.effective,
  };
}

/**
 * Tokens to protect verbatim at the tail. By construction, when compaction
 * fires the protected tail receives `(1 - triggerRatio)` of the window plus
 * a slack proportional to the protectRatio. Default 40% — caller can
 * override for tighter tails on tight context windows.
 */
export interface ProtectTokensInputs {
  model: string;
  /** Fraction of effective window kept verbatim as the tail. Default 0.40. */
  protectRatio?: number;
}

/**
 * Default lowered from 0.40 → 0.15 (keep the recent ~15% verbatim). 40% proved
 * larger than needed and inflated every prompt; a smaller tail + the summary is
 * enough to retain the immediate working state (incl. recent tool calls).
 * Override per-install via `CODER_COMPACT_PROTECT_RATIO` (Settings → exposed).
 */
export const DEFAULT_PROTECT_RATIO = 0.15;

/** Env-resolved protect ratio, clamped so a typo can't zero/expand the tail. */
export function resolveProtectRatio(): number {
  const raw = process.env.CODER_COMPACT_PROTECT_RATIO;
  if (!raw) return DEFAULT_PROTECT_RATIO;
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_PROTECT_RATIO;
  return Math.min(0.6, Math.max(0.05, n));
}

export function computeProtectTokens(inp: ProtectTokensInputs): number {
  const limits = deriveTokenLimits(inp.model);
  const ratio = inp.protectRatio ?? resolveProtectRatio();
  return Math.max(1, Math.floor(limits.effective * ratio));
}

/**
 * Ceiling ratio for how far `recedeToPreserveLastNTurns` may grow the protected
 * tail when honoring the "preserve last N user turns" rule. Without a ceiling, a
 * single long user turn (one request → many tool calls, so the whole history has
 * < N user messages) makes recede preserve EVERYTHING — the compactor then
 * no-ops while the size gate keeps firing every turn (a no-op compaction
 * loop, confirmed in telemetry: one run churned 94 consecutive no-ops). Capping
 * the tail at 50% of the effective window — comfortably below the trigger
 * ratio, leaving room for the synthetic summary — guarantees the post-compaction
 * prompt lands below the trigger. Override via `CODER_COMPACT_RECEDE_TAIL_RATIO`,
 * clamped to stay above the protect floor and below the trigger.
 */
export const DEFAULT_RECEDE_TAIL_RATIO = 0.5;

export function resolveRecedeTailRatio(): number {
  const raw = process.env.CODER_COMPACT_RECEDE_TAIL_RATIO;
  const n = raw ? Number(raw) : NaN;
  const ratio = Number.isFinite(n) ? n : DEFAULT_RECEDE_TAIL_RATIO;
  // Clamp against the RESOLVED trigger ratio (not the constant) so an env
  // override of the trigger keeps the post-compaction prompt below it.
  return Math.min(resolveTriggerRatio() - 0.05, Math.max(resolveProtectRatio(), ratio));
}

/**
 * P3 — context-relative ceiling (in CHARS) on how large a single `tool_result`
 * may be kept inline, applied ON TOP of the user's output-cap level. A single
 * result bigger than the protected tail can never be summarized by compaction
 * (the tail is kept verbatim), so it deadlocks the pre-emit gate
 * (`compact_exhausted`). Capping a single result to under the protect budget —
 * and spilling the rest to the side-file store (recoverable via
 * `get_tool_output`) — prevents the deadlock at the source.
 *
 *   ceilingChars = (protectTokens − MARGIN) × CHARS_PER_TOKEN_DENSE × ratio
 *
 * `CHARS_PER_TOKEN_DENSE = 2` (the densest `estimateBlockTokens` rate) makes the
 * bound SAFE: even JSON-dense content kept inline estimates ≤ `protectTokens`.
 * The `MARGIN` reserves room for the per-block overhead `estimateBlockTokens`
 * adds (~8 tokens) plus the truncation/recovery marker `capToolContent` appends
 * (~180 tokens) — without it a block clamped exactly at the ceiling would
 * estimate a few hundred tokens OVER protect and still be the no-op cause. Same
 * spirit as the `ultra` cap note ("bounded — a hard ceiling prevents a single
 * tool dump from overflowing the model context window").
 */
const CONTEXT_SPILL_CHARS_PER_TOKEN = 2;
/** Tokens reserved for per-block overhead + the recovery marker (see above). */
const CONTEXT_SPILL_MARGIN_TOKENS = 256;
export const DEFAULT_CONTEXT_SPILL_RATIO = 1;

/**
 * Resolve the context-spill ratio knob. `0`/negative/non-finite → OFF
 * (`0` return), restoring legacy behaviour (only the user's cap applies).
 */
export function resolveContextSpillRatio(): number {
  const raw = process.env.CODER_CONTEXT_SPILL_RATIO;
  if (raw == null || raw === '') return DEFAULT_CONTEXT_SPILL_RATIO;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n;
}

/**
 * Char ceiling for a single inline `tool_result`. `Infinity` when the knob is
 * off → caller applies only its own cap. The reserved margin guarantees a block
 * clamped AT this ceiling still estimates ≤ `protectTokens` (overhead + marker
 * included), so it can never be the cutoff-collapse no-op cause.
 */
export function contextSpillCeilingChars(model: string): number {
  const ratio = resolveContextSpillRatio();
  if (ratio <= 0) return Number.POSITIVE_INFINITY;
  const protectTokens = computeProtectTokens({ model });
  const budgetTokens = protectTokens - CONTEXT_SPILL_MARGIN_TOKENS;
  return Math.max(1, Math.floor(budgetTokens * CONTEXT_SPILL_CHARS_PER_TOKEN * ratio));
}

/**
 * Effective per-`tool_result` push-time cap: the user's cap clamped by the
 * context-relative ceiling. Extracted (and exported) so the clamp wiring is
 * unit-testable independently of `CoderRunner`. `Infinity` ceiling (knob off)
 * → the user's cap wins unchanged.
 */
export function resolveFinalizeCap(userCap: number, model: string): number {
  return Math.min(userCap, contextSpillCeilingChars(model));
}

/**
 * Durable auto-compaction toggle (`MCP_DURABLE_COMPACTION`, default ON). When
 * on, each in-memory compaction is also persisted as a boundary + summary so
 * the reduced context (and its cost) carries to the next run.
 */
export function durableCompactionEnabled(): boolean {
  const raw = process.env.MCP_DURABLE_COMPACTION;
  if (raw == null || raw === '') return true;
  const v = raw.toLowerCase();
  return v !== '0' && v !== 'false' && v !== 'off';
}
