import { describe, expect, it } from 'vitest';
import {
  freshPromptTokens,
  promptCacheHitRatio,
  promptInputTokens,
} from '../prompt-cache-metrics.js';

describe('prompt cache metrics', () => {
  it('adds Anthropic fresh, cache-read, and cache-write slices', () => {
    const usage = {
      provider: 'claude-code',
      inputTokens: 2,
      cacheReadTokens: 27_487,
      cacheCreationTokens: 500_786,
    };

    expect(promptInputTokens(usage)).toBe(528_275);
    expect(freshPromptTokens(usage)).toBe(2);
    expect(promptCacheHitRatio(usage)).toBeCloseTo(27_487 / 528_275);
  });

  it('does not double-count cache reads already included by OpenAI-style APIs', () => {
    const usage = {
      provider: 'openai',
      inputTokens: 528_275,
      cacheReadTokens: 27_487,
      cacheCreationTokens: 0,
    };

    expect(promptInputTokens(usage)).toBe(528_275);
    expect(freshPromptTokens(usage)).toBe(500_788);
    expect(promptCacheHitRatio(usage)).toBeCloseTo(27_487 / 528_275);
  });
});

