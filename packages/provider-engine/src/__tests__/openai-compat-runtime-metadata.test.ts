import { beforeEach, describe, expect, it, vi } from 'vitest';

const { constructedWith } = vi.hoisted(() => ({
  constructedWith: [] as Array<Record<string, unknown>>,
}));
const { responsesConstructedWith } = vi.hoisted(() => ({
  responsesConstructedWith: [] as Array<Record<string, unknown>>,
}));

vi.mock('@mcp/code-agent/providers/openai.js', () => ({
  OpenAIChatProvider: class FakeOpenAIChatProvider {
    constructor(opts: Record<string, unknown>) {
      constructedWith.push(opts);
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
const { fuguSpec, openaiSpec, zaiSpec } = await import('../specs/openai-compat.js');

describe('openai-compat runtime model metadata', () => {
  beforeEach(() => {
    constructedWith.length = 0;
    responsesConstructedWith.length = 0;
  });

  it('forwards persisted per-model output limits to the coder adapter', () => {
    const wire = buildOpenAICompat(zaiSpec);
    wire.createCoder!(
      { apiKey: 'k', extra: {} },
      'glm-5.1',
      {
        providerModels: [
          { model_id: 'glm-5.1', default_max_tokens: 24_000 },
          { model_id: 'glm-4.7', default_max_tokens: null },
        ],
      },
    );

    expect(constructedWith.at(-1)?.modelMaxOutputTokens).toEqual({
      'glm-5.1': 24_000,
    });
  });

  it('uses the active transport mode instead of colliding rows by model id', () => {
    const wire = buildOpenAICompat(zaiSpec);
    wire.createCoder!(
      { apiKey: 'k', extra: {} },
      'glm-5.1::coding',
      {
        providerModels: [
          { model_id: 'glm-5.1', mode: '', default_max_tokens: 8_000 },
          { model_id: 'glm-5.1', mode: 'coding', default_max_tokens: 32_000 },
        ],
      },
    );

    expect(constructedWith.at(-1)?.model).toBe('glm-5.1');
    expect(constructedWith.at(-1)?.modelMaxOutputTokens).toEqual({
      'glm-5.1': 32_000,
    });
  });

  it('routes Fugu through stateless Responses with native model metadata', () => {
    const wire = buildOpenAICompat(fuguSpec);
    wire.createCoder!(
      { apiKey: 'fish_test', extra: {} },
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

    expect(constructedWith).toHaveLength(0);
    expect(responsesConstructedWith.at(-1)).toMatchObject({
      name: 'fugu',
      apiKey: 'fish_test',
      baseURL: 'https://api.sakana.ai/v1',
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

  it('routes the current OpenAI API through stateful Responses with visible summaries', () => {
    const wire = buildOpenAICompat(openaiSpec);
    wire.createCoder!(
      { apiKey: 'sk-test', extra: {} },
      'gpt-5.6-sol',
      {
        providerModels: [{
          model_id: 'gpt-5.6-sol',
          supported_reasoning_levels: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
          default_reasoning_level: 'medium',
          apply_patch_tool_type: 'freeform',
        }],
      },
    );

    expect(constructedWith).toHaveLength(0);
    expect(responsesConstructedWith.at(-1)).toMatchObject({
      name: 'openai',
      apiKey: 'sk-test',
      baseURL: 'https://api.openai.com/v1',
      model: 'gpt-5.6-sol',
      reasoning: {
        supportedLevels: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
        defaultLevel: 'medium',
      },
      applyPatchToolType: 'freeform',
      codexHeaders: false,
      statefulResponses: true,
      reasoningFromThinking: true,
      reasoningSummary: 'auto',
    });
  });
});
