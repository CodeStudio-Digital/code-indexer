import { beforeEach, describe, expect, it, vi } from 'vitest';

const { constructedWith } = vi.hoisted(() => ({
  constructedWith: [] as Array<Record<string, unknown>>,
}));

vi.mock('@mcp/code-agent/providers/openai.js', () => ({
  OpenAIChatProvider: class FakeOpenAIChatProvider {
    constructor(opts: Record<string, unknown>) {
      constructedWith.push(opts);
    }
  },
}));

const { buildOpenAICompat } = await import('../wires/openai-compat.js');
const { zaiSpec } = await import('../specs/openai-compat.js');

describe('openai-compat runtime model metadata', () => {
  beforeEach(() => {
    constructedWith.length = 0;
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
});
