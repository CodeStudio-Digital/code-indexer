import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderSpec } from '@mcp/provider-sdk';

const { constructedWith } = vi.hoisted(() => ({
  constructedWith: [] as Array<Record<string, unknown>>,
}));

vi.mock('@mcp/code-agent/providers/chatgpt.js', () => ({
  ChatGPTCodexProvider: class FakeChatGPTCodexProvider {
    constructor(opts: Record<string, unknown>) {
      constructedWith.push(opts);
    }
  },
}));

const { buildCodex } = await import('../wires/codex.js');

const chatgptSpec: ProviderSpec = {
  kind: 'openai-chatgpt',
  displayName: 'ChatGPT (Codex)',
  credKind: 'oauth',
  envVars: [],
  defaultModels: ['gpt-5.6-sol'],
  defaultModel: 'gpt-5.6-sol',
  pricing: {},
  wire: 'codex',
};

describe('provider-runtime Codex reasoning visibility', () => {
  beforeEach(() => {
    constructedWith.length = 0;
  });

  it('requests readable reasoning summaries for supported Codex models', () => {
    const wire = buildCodex(chatgptSpec);
    wire.createCoder!(
      { apiKey: 'k', extra: {} },
      'gpt-5.6-sol',
      {
        providerModels: [
          {
            model_id: 'gpt-5.6-sol',
            supported_reasoning_levels: ['low', 'medium', 'high', 'xhigh', 'max'],
            default_reasoning_level: 'medium',
          },
        ],
      },
    );

    expect(constructedWith.at(-1)).toMatchObject({
      model: 'gpt-5.6-sol',
      reasoningSummary: 'auto',
      reasoningSummaryFromThinking: true,
      parallelToolCalls: true,
      reasoning: {
        supportedLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
        defaultLevel: 'medium',
      },
    });
  });
});
