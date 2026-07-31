import { describe, expect, it } from 'vitest';
import { resolveBedrockReasoningRequest } from '../bedrock.js';

describe('Bedrock current reasoning request fields', () => {
  it('uses adaptive summarized thinking and native effort for Claude 5', () => {
    expect(resolveBedrockReasoningRequest('us.anthropic.claude-sonnet-5', {
      thinking: true,
      reasoningEffort: 'xhigh',
    })).toEqual({
      thinking: { type: 'adaptive', display: 'summarized' },
      output_config: { effort: 'max' },
    });
  });

  it('maps Nova 2 to reasoningConfig', () => {
    expect(resolveBedrockReasoningRequest('amazon.nova-2-lite-v1:0', {
      thinking: true,
      reasoningEffort: 'high',
    })).toEqual({
      reasoningConfig: { type: 'enabled', maxReasoningEffort: 'high' },
    });
  });

  it('can explicitly disable Nova reasoning', () => {
    expect(resolveBedrockReasoningRequest('amazon.nova-2-lite-v1:0', {
      thinking: false,
      reasoningEffort: 'none',
    })).toEqual({
      reasoningConfig: { type: 'disabled' },
    });
  });
});
