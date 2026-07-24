import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  observePromptCache,
  promptCacheMissGuardMessage,
} from '../prompt-cache-miss.js';

afterEach(() => vi.unstubAllEnvs());

describe('prompt-cache miss guard', () => {
  it('trips after two explicit misses above 100k tokens', () => {
    const usage = {
      input_tokens: 327_000,
      output_tokens: 10,
      prompt_tokens_total: 327_000,
      cache_read_input_tokens: 0,
    };
    const first = observePromptCache('openrouter', usage, 0);
    const second = observePromptCache('openrouter', usage, first.consecutiveMisses);

    expect(first).toMatchObject({ consecutiveMisses: 1, tripped: false });
    expect(second).toMatchObject({ consecutiveMisses: 2, tripped: true });
    expect(promptCacheMissGuardMessage(second)).toContain('327000');
  });

  it('resets after a cache hit', () => {
    const result = observePromptCache(
      'openrouter',
      {
        input_tokens: 327_000,
        output_tokens: 10,
        prompt_tokens_total: 327_000,
        cache_read_input_tokens: 326_000,
      },
      1,
    );
    expect(result).toMatchObject({ consecutiveMisses: 0, tripped: false });
  });

  it('does not classify small, unknown, or non-OpenRouter prompts as misses', () => {
    expect(observePromptCache('openrouter', {
      input_tokens: 99_999,
      output_tokens: 1,
      cache_read_input_tokens: 0,
    }, 1).consecutiveMisses).toBe(0);
    expect(observePromptCache('openrouter', {
      input_tokens: 200_000,
      output_tokens: 1,
    }, 1).consecutiveMisses).toBe(0);
    expect(observePromptCache('openai', {
      input_tokens: 200_000,
      output_tokens: 1,
      cache_read_input_tokens: 0,
    }, 1).consecutiveMisses).toBe(0);
  });

  it('honors configurable thresholds and miss count', () => {
    vi.stubEnv('CODER_CACHE_MISS_GUARD_PROMPT_TOKENS', '10');
    vi.stubEnv('CODER_CACHE_MISS_GUARD_MAX', '1');
    expect(observePromptCache('openrouter', {
      input_tokens: 10,
      output_tokens: 1,
      cache_read_input_tokens: 0,
    }, 0)).toMatchObject({ consecutiveMisses: 1, tripped: true });
  });
});
