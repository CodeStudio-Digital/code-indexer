import type { PromptContextMeasurement } from '@mcp/provider-sdk/prompt-cache-metrics.js';
export { freshPromptTokens, promptCacheHitRatio, promptInputTokens } from '@mcp/provider-sdk/prompt-cache-metrics.js';

export interface SessionContextStats {
  last_turn_input_tokens?: number;
  last_turn_prompt_tokens?: number | null;
  last_turn_context?: PromptContextMeasurement | null;
  context_window?: number | null;
  effective_context_window?: number | null;
}

export function sessionContextUsage(
  session: { last_turn_input_tokens?: number },
  stats: SessionContextStats | null,
  live?: PromptContextMeasurement | null,
) {
  const measurement = live ?? stats?.last_turn_context;
  const tokens = measurement?.prompt_tokens ?? stats?.last_turn_prompt_tokens
    ?? stats?.last_turn_input_tokens ?? session.last_turn_input_tokens ?? 0;
  const window = measurement?.context_window ?? stats?.effective_context_window ?? stats?.context_window ?? null;
  const percent = window && tokens > 0 ? Math.min(100, Math.round(tokens / window * 1000) / 10) : null;
  return { tokens, window, percent, estimated: measurement?.source === 'estimate' };
}
