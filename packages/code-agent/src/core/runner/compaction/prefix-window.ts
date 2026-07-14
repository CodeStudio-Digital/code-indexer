/**
 * BodyAfterPrefix token accounting (PR-F).
 *
 * Inspired by Codex' `compact.rs`: when a provider supports prompt-cache
 * (Anthropic + cache header, OpenAI w/ prefix caching), the system
 * prompt + tools array become an IMMUTABLE prefix that the provider
 * doesn't bill again on cache hits. Counting them against `effective`
 * therefore triggers compaction earlier than it needs to — the body
 * (history of user/assistant/tool messages) is the real growth axis.
 *
 * This module:
 *   - `computePrefixTokens(systemPrompt, tools)` — cheap char-count
 *     estimate of the prefix size in tokens.
 *   - `shouldCompactBodyAfterPrefix({...})` — gate that subtracts
 *     prefix tokens from the headroom before applying the trigger
 *     ratio.
 *   - `computeBodyTokens(promptTokens, prefixTokens)` — convenience.
 *
 * Threshold default = 0.85 (more aggressive than the 0.90 used for the
 * total-token path) because the body bears all the variance and we
 * want to compact before the body alone fills the window.
 */
import { deriveTokenLimits, resolveTriggerRatio } from '@mcp/code-agent/core/compaction/limits.js';

/** Char-count → tokens approximation. Same convention as the legacy path. */
const CHARS_PER_TOKEN = 4;

/**
 * Estimate the prefix-token count given the current system prompt and
 * tool definitions. The estimate is intentionally cheap (no real
 * tokenizer); used only as a relative quantity in `shouldCompactBodyAfterPrefix`.
 */
export function computePrefixTokens(
  systemPrompt: string,
  tools: ReadonlyArray<{ name: string; description?: string; parameters?: unknown }>,
): number {
  let chars = systemPrompt.length;
  for (const t of tools) {
    chars += t.name.length;
    if (t.description) chars += t.description.length;
    if (t.parameters !== undefined) {
      try {
        chars += JSON.stringify(t.parameters).length;
      } catch {
        // Circular params → skip; the actual provider rejects it later.
      }
    }
    chars += 16; // small per-tool framing overhead (name/description tags)
  }
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

export interface ShouldCompactBodyAfterPrefixInputs {
  /** Last known prompt-token count from the provider response. */
  promptTokens: number;
  /** Prefix-token estimate from `computePrefixTokens`. */
  prefixTokens: number;
  /** Model id — used to look up the effective context window. */
  model: string;
  contextWindow?: number | null;
  /**
   * Compaction trigger ratio applied to BODY headroom (effective - prefix).
   * Default 0.85 — more aggressive than the legacy 0.90 because the body
   * bears all the variance.
   */
  triggerRatio?: number;
}

export interface BodyAfterPrefixDecision {
  shouldCompact: boolean;
  /** Tokens attributed to body alone (promptTokens - prefixTokens). */
  bodyTokens: number;
  /** Body capacity available (effective - prefixTokens). */
  bodyCapacity: number;
  /** body / bodyCapacity — useful for telemetry. */
  ratio: number;
  /** Effective context from `deriveTokenLimits`. */
  effective: number;
}

export const DEFAULT_BODY_AFTER_PREFIX_RATIO = 0.85;

/**
 * Body gate default derived from the single trigger knob: trigger ratio − 0.05
 * (0.85 with the default 0.90). Subtracting the prefix from both numerator and
 * denominator INCREASES the ratio, so the body gate naturally fires slightly
 * before the total gate — keeping it 5pp tighter preserves that ordering for
 * any `CODER_COMPACT_TRIGGER_RATIO` override.
 */
export function resolveBodyAfterPrefixRatio(): number {
  return Math.max(0.5, resolveTriggerRatio() - 0.05);
}

/**
 * Decide whether to compact based on BODY usage, ignoring the prefix
 * (system + tools) which a prompt-cache-aware provider doesn't re-bill.
 *
 * Falls back to "shouldn't compact" when inputs are degenerate
 * (negative body, effective <= 0). Callers should fall through to the
 * legacy `shouldCompact90` path when this returns `shouldCompact=false`
 * AND they don't trust prefix caching (no Anthropic cache header).
 */
export function shouldCompactBodyAfterPrefix(
  inp: ShouldCompactBodyAfterPrefixInputs,
): BodyAfterPrefixDecision {
  const limits = deriveTokenLimits(inp.model, inp.contextWindow);
  const triggerRatio = inp.triggerRatio ?? resolveBodyAfterPrefixRatio();
  const bodyTokens = Math.max(0, inp.promptTokens - inp.prefixTokens);
  const bodyCapacity = Math.max(0, limits.effective - inp.prefixTokens);
  if (bodyCapacity <= 0 || bodyTokens <= 0) {
    return { shouldCompact: false, bodyTokens, bodyCapacity, ratio: 0, effective: limits.effective };
  }
  const ratio = bodyTokens / bodyCapacity;
  return {
    shouldCompact: ratio >= triggerRatio,
    bodyTokens,
    bodyCapacity,
    ratio,
    effective: limits.effective,
  };
}

/**
 * Convenience helper for callers that want both the prefix calc and
 * the decision in one shot (provider already known to support cache).
 */
export function decideCompactionBodyAfterPrefix(args: {
  promptTokens: number;
  systemPrompt: string;
  tools: ReadonlyArray<{ name: string; description?: string; parameters?: unknown }>;
  model: string;
  contextWindow?: number | null;
  triggerRatio?: number;
}): BodyAfterPrefixDecision & { prefixTokens: number } {
  const prefixTokens = computePrefixTokens(args.systemPrompt, args.tools);
  const decision = shouldCompactBodyAfterPrefix({
    promptTokens: args.promptTokens,
    prefixTokens,
    model: args.model,
    contextWindow: args.contextWindow,
    triggerRatio: args.triggerRatio,
  });
  return { ...decision, prefixTokens };
}
