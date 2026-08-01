import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderSpec } from '@mcp/provider-sdk';

const { chatConstructedWith, responsesConstructedWith } = vi.hoisted(() => ({
  chatConstructedWith: [] as Array<Record<string, unknown>>,
  responsesConstructedWith: [] as Array<Record<string, unknown>>,
}));

vi.mock('@mcp/code-agent/providers/openai.js', () => ({
  OpenAIChatProvider: class FakeOpenAIChatProvider {
    constructor(opts: Record<string, unknown>) {
      chatConstructedWith.push(opts);
    }
  },
}));

vi.mock('@mcp/code-agent/providers/chatgpt.js', () => ({
  ChatGPTCodexProvider: class FakeChatGPTCodexProvider {
    constructor(opts: Record<string, unknown>) {
      responsesConstructedWith.push(opts);
    }
  },
}));

const { buildOpenAICompat } = await import('../wires/openai-compat.js');

const fuguSpec: ProviderSpec = {
  kind: 'fugu',
  displayName: 'Sakana AI Fugu',
  credKind: 'api-key',
  envVars: ['FUGU_API_KEY'],
  defaultBaseURL: 'https://api.sakana.ai/v1',
  defaultModels: ['fugu', 'fugu-ultra-v1.1'],
  defaultModel: 'fugu',
  pricing: {},
  wire: 'openai-compat',
  wireOpts: {
    vendor: 'fugu',
    responsesApi: true,
    responsesStateless: true,
    responsesReasoningSummaryModels: ['fugu-ultra-v1.1'],
    responsesIncludeOrchestrationUsage: true,
  },
};

describe('provider-runtime openai-compat Responses wire', () => {
  beforeEach(() => {
    chatConstructedWith.length = 0;
    responsesConstructedWith.length = 0;
  });

  it('constructs the Sakana Responses adapter used by bundled plugins', () => {
    const wire = buildOpenAICompat(fuguSpec);
    wire.createCoder!(
      { apiKey: 'fish_test', baseURL: 'https://api.sakana.ai/v1', extra: {} },
      'fugu-ultra-v1.1',
      {
        providerModels: [
          {
            model_id: 'fugu-ultra-v1.1',
            supported_reasoning_levels: ['high', 'xhigh', 'max'],
            default_reasoning_level: 'xhigh',
            apply_patch_tool_type: 'freeform',
          },
        ],
      },
    );

    expect(chatConstructedWith).toHaveLength(0);
    expect(responsesConstructedWith.at(-1)).toMatchObject({
      name: 'fugu',
      model: 'fugu-ultra-v1.1',
      reasoning: {
        supportedLevels: ['high', 'xhigh', 'max'],
        defaultLevel: 'xhigh',
      },
      applyPatchToolType: 'freeform',
      codexHeaders: false,
      statefulResponses: false,
      reasoningFromThinking: false,
      reasoningSummary: 'auto',
      includeOrchestrationUsage: true,
    });
  });
});
