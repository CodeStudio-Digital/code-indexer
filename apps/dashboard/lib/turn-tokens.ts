/** Per-call counters as reported by the provider. Some providers include cached
 * tokens in input, so the cache figures must never be added to a displayed total. */
export interface TurnTokens {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens?: number;
  cache_creation_tokens?: number;
}

export function hasTurnTokens(usage?: TurnTokens): usage is TurnTokens {
  return !!usage && (usage.input_tokens > 0 || usage.output_tokens > 0
    || (usage.cache_read_tokens ?? 0) > 0 || (usage.cache_creation_tokens ?? 0) > 0);
}
