/** Input context of one provider call, independent of billed usage. */
export interface PromptContextMeasurement {
  prompt_tokens: number;
  context_window: number;
  source: 'usage' | 'estimate';
}

interface PromptCacheUsage {
  provider: string | null | undefined;
  inputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

/** Providers whose usage splits the prompt into fresh/read/write slices. */
function usesSplitPromptCacheAccounting(provider: string | null | undefined): boolean {
  return provider === 'anthropic' || provider === 'claude-code' || provider === 'bedrock';
}

export function promptInputTokens(usage: PromptCacheUsage): number {
  if (!usesSplitPromptCacheAccounting(usage.provider)) return usage.inputTokens;
  return usage.inputTokens + usage.cacheReadTokens + usage.cacheCreationTokens;
}

export function freshPromptTokens(usage: PromptCacheUsage): number {
  if (usesSplitPromptCacheAccounting(usage.provider)) return usage.inputTokens;
  return Math.max(0, usage.inputTokens - usage.cacheReadTokens);
}

export function promptCacheHitRatio(usage: PromptCacheUsage): number | null {
  const total = promptInputTokens(usage);
  return total > 0 ? usage.cacheReadTokens / total : null;
}

