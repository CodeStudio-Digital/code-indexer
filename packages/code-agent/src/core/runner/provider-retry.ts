import {
  transientRetryInitialMs,
  transientRetryMaxMs,
  transientRetryJitter,
} from './recovery-config.js';

/**
 * Provider error classifier — returns a short human-readable reason
 * string when the error is NOT a transient one we should retry, and
 * `null` when normal retry/transient handling should proceed.
 *
 * Today this catches the Anthropic "extra usage exhausted" family of
 * errors so the runner stops banging on the API while billing balloons
 * (they're 402s in disguise; retrying makes the user pay for nothing).
 */
export function nonRetryableProviderErrorReason(error: Error, raw: unknown): string | null {
  const candidates = [
    error.message,
    (raw as { error?: { message?: unknown } })?.error?.message,
    (raw as { error?: { type?: unknown } })?.error?.type,
    (raw as { code?: unknown })?.code,
  ];
  const text = candidates
    .filter((value): value is string => typeof value === 'string')
    .join('\n')
    .toLowerCase();

  if (
    text.includes('out of extra usage') ||
    text.includes('claude.ai/settings/usage') ||
    text.includes('out_of_credits')
  ) {
    return 'provider quota/extra usage exhausted';
  }
  return null;
}

/**
 * Substrings that mark a context-window overflow across provider families.
 * Kept lowercase; matched against message + code. Sources:
 *   - Anthropic: "prompt is too long: N tokens > M maximum",
 *     "input length and max_tokens exceed context limit"
 *   - OpenAI-compat (OpenAI/DeepSeek/ZAI): "This model's maximum context
 *     length is N tokens...", code `context_length_exceeded`,
 *     "exceeds the context window", "input length exceeds"
 *   - Gemini: "input token count (N) exceeds the maximum number of tokens"
 *   - Kimi/Moonshot: "exceeded model token limit"
 */
const OVERFLOW_SIGNATURES = [
  'prompt is too long',
  'context_length_exceeded',
  'maximum context length',
  'exceeds the context window',
  'exceed context limit',
  'exceeds the maximum number of tokens',
  'exceeded model token limit',
  'input length exceeds',
  'maximum input length',
  'too many tokens',
] as const;

/**
 * True when a provider error is a context-window overflow. These are
 * deterministic — retrying the same payload can never succeed — so the
 * Recovering node routes them to Compacting instead of retry/abort.
 */
export function isContextOverflowError(message?: string, code?: string): boolean {
  const text = [message, code]
    .filter((v): v is string => typeof v === 'string' && v.length > 0)
    .join('\n')
    .toLowerCase();
  if (!text) return false;
  return OVERFLOW_SIGNATURES.some((sig) => text.includes(sig));
}

/**
 * Tenacity-style exp+jitter backoff. Mirrors kimi-cli's
 * `wait_exponential_jitter(initial=0.3, max=5, jitter=0.5)`. Returns
 * the delay in milliseconds for a 1-based attempt number.
 *
 * Curve: a=1 → initial; a=2 → 2*initial; a=3 → 4*initial; capped at
 * `max`. Symmetric jitter in `[-jitter*base, +jitter*base]` so the
 * retries from many concurrent runners don't synchronize.
 */
export function backoffDelayMs(
  attempt: number,
  opts: { initialMs?: number; maxMs?: number; jitter?: number; rng?: () => number } = {},
): number {
  const initial = opts.initialMs ?? transientRetryInitialMs();
  const max = opts.maxMs ?? transientRetryMaxMs();
  const jitter = opts.jitter ?? transientRetryJitter();
  const rng = opts.rng ?? Math.random;
  const a = Math.max(1, Math.floor(attempt));
  // Exp curve (1 → initial, 2 → 2*initial, 3 → 4*initial, ...) capped at max.
  const baseExp = Math.min(max, initial * Math.pow(2, a - 1));
  // Symmetric jitter in [-j*base, +j*base].
  const jitterAmount = baseExp * jitter * (rng() * 2 - 1);
  return Math.max(0, Math.round(baseExp + jitterAmount));
}
