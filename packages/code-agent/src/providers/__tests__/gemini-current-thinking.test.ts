import { describe, expect, it } from 'vitest';
import { ThinkingLevel } from '@google/genai';
import { resolveGeminiThinkingConfig } from '../gemini.js';

describe('Gemini current thinking controls', () => {
  it('maps max onto Gemini 3.6 Flash high and requests visible thoughts', () => {
    expect(resolveGeminiThinkingConfig('gemini-3.6-flash', {
      thinking: true,
      reasoningEffort: 'max',
    })).toEqual({
      includeThoughts: true,
      thinkingLevel: ThinkingLevel.HIGH,
    });
  });

  it('does not send unsupported minimal to Gemini 3.1 Pro', () => {
    expect(resolveGeminiThinkingConfig('gemini-3.1-pro', {
      thinking: true,
      reasoningEffort: 'minimal',
    })).toEqual({
      includeThoughts: true,
      thinkingLevel: ThinkingLevel.LOW,
    });
  });

  it('keeps Gemini 2.5 on the token-budget contract', () => {
    expect(resolveGeminiThinkingConfig('gemini-2.5-flash', {
      thinking: true,
      reasoningEffort: 'high',
    })).toMatchObject({
      includeThoughts: true,
      thinkingBudget: 24_576,
    });
  });
});
