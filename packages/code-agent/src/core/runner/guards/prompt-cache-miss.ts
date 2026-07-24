import type { ChatUsage } from '@mcp/code-agent/core/messages.js';
import { promptTokensTotal } from '@mcp/code-agent/core/messages.js';

export interface PromptCacheMissObservation {
  consecutiveMisses: number;
  tripped: boolean;
  promptTokens: number | null;
  cachedTokens: number | null;
  thresholdTokens: number;
  maxMisses: number;
}

function positiveEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw != null && raw !== '') {
    const value = Number(raw);
    if (Number.isFinite(value) && value > 0) return Math.floor(value);
  }
  return fallback;
}

/**
 * Protects expensive OpenRouter agent loops from repeatedly re-sending a
 * large prefix at full input price. Unknown/missing usage is not classified
 * as a miss; only an explicit zero cached-token count is.
 */
export function observePromptCache(
  provider: string,
  usage: ChatUsage | null,
  previousConsecutiveMisses: number,
): PromptCacheMissObservation {
  const thresholdTokens = positiveEnv('CODER_CACHE_MISS_GUARD_PROMPT_TOKENS', 100_000);
  const maxMisses = positiveEnv('CODER_CACHE_MISS_GUARD_MAX', 2);
  const promptTokens = promptTokensTotal(usage);
  const cachedTokens =
    typeof usage?.cache_read_input_tokens === 'number'
      ? usage.cache_read_input_tokens
      : null;

  if (
    provider.toLowerCase() !== 'openrouter'
    || promptTokens == null
    || cachedTokens == null
    || promptTokens < thresholdTokens
  ) {
    return {
      consecutiveMisses: 0,
      tripped: false,
      promptTokens,
      cachedTokens,
      thresholdTokens,
      maxMisses,
    };
  }

  const consecutiveMisses =
    cachedTokens === 0 ? previousConsecutiveMisses + 1 : 0;
  return {
    consecutiveMisses,
    tripped: consecutiveMisses >= maxMisses,
    promptTokens,
    cachedTokens,
    thresholdTokens,
    maxMisses,
  };
}

export function promptCacheMissGuardMessage(
  observation: PromptCacheMissObservation,
): string {
  return (
    `Prompt-cache protection stopped the run after ` +
    `${observation.consecutiveMisses} consecutive OpenRouter cache misses ` +
    `on prompts >= ${observation.thresholdTokens} tokens ` +
    `(last prompt=${observation.promptTokens ?? 'unknown'}, ` +
    `cached=${observation.cachedTokens ?? 'unknown'}).`
  );
}
