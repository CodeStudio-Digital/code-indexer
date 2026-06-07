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
import { deriveTokenLimits } from '@mcp/code-agent/core/compaction/limits.js';

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
 * Frente B (PR 2 da reavaliação) — desceu de 0.9 → 0.75. Com o char
 * compactor legacy morto, o LLM compactor precisa disparar ANTES da
 * pressão real para preservar fidelidade (90% deixava pouco espaço para
 * o LLM auxiliar trabalhar; 75% antecipa o resumo enquanto ainda há
 * 25% de janela disponível para o turno em curso).
 *
 * Fix B — desceu 0.75 → 0.70. A degradação de coerência observada na sessão
 * 887 (gpt-5.5, janela 272k) já estava instalada por volta de ~150k = ~0.60
 * da janela efetiva; 0.70 antecipa o resumo sem ser um número fixo (continua
 * RELATIVO à janela: 0.70×272k≈176k, 0.70×1M=700k — escala com o modelo, ao
 * contrário de um cap absoluto, que seria prematuro em 272k e absurdo em 1M).
 * Env-ajustável por `triggerRatio` no call-site.
 */
export const DEFAULT_TRIGGER_RATIO = 0.70;

export function shouldCompact90(inp: CompactionThresholdInputs): CompactionThresholdDecision {
  const limits = deriveTokenLimits(inp.model);
  const triggerRatio = inp.triggerRatio ?? DEFAULT_TRIGGER_RATIO;
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
