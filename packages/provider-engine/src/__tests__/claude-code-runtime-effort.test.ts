import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  constructedWith: [] as Array<Record<string, unknown>>,
  resolutions: [] as Array<{ model: string; options: Record<string, unknown> }>,
}));

vi.mock('@mcp/code-agent/providers/anthropic.js', () => ({
  AnthropicChatProvider: class FakeAnthropicChatProvider {
    constructor(opts: Record<string, unknown>) {
      state.constructedWith.push(opts);
    }
  },
}));

vi.mock('@mcp/services/providers/shared/store.js', () => ({
  getStore: () => null,
}));

vi.mock('@mcp/services/services/oauth/claude-code.js', () => ({
  getClaudeCodeSystemPrefixBlocks: () => [],
  resolveClaudeCodeModel: (model: string, _account: unknown, options: Record<string, unknown>) => {
    state.resolutions.push({ model, options });
    return {
      apiModel: model,
      requestedModel: model,
      displayModel: model,
      maxTokens: 8_192,
      betas: [],
      thinking: undefined,
      outputConfig: options.effort ? { effort: options.effort } : undefined,
      effort: options.effort ?? null,
    };
  },
}));

const { buildClaudeCode } = await import('../wires/claude-code.js');
const { claudeCodeSpec } = await import('../specs/claude-code.js');

describe('claude-code runtime effort', () => {
  beforeEach(() => {
    state.constructedWith.length = 0;
    state.resolutions.length = 0;
  });

  it('uses exact mode metadata and lets the normalized request override it', () => {
    const wire = buildClaudeCode(claudeCodeSpec);
    wire.createCoder!(
      { apiKey: 'k', extra: {} },
      'claude-test::deep',
      {
        providerModels: [
          { model_id: 'claude-test', mode: '', default_reasoning_level: 'low' },
          { model_id: 'claude-test', mode: 'deep', default_reasoning_level: 'high' },
        ],
      },
    );

    expect(state.constructedWith.at(-1)?.model).toBe('claude-test');
    expect(state.constructedWith.at(-1)).toMatchObject({
      cacheMessages: true,
      promptCacheTtl: '1h',
    });
    expect(state.resolutions[0]).toEqual(expect.objectContaining({
      model: 'claude-test',
      options: expect.objectContaining({
        effort: 'high',
        promptCacheTtl: '1h',
        thinkingDisplay: 'summarized',
      }),
    }));

    const resolveModel = state.constructedWith.at(-1)?.resolveModel as (
      model: string,
      req: Record<string, unknown>,
    ) => unknown;
    resolveModel('claude-test', { tools: [], reasoningEffort: 'xhigh' });
    expect(state.resolutions[1]?.options.effort).toBe('xhigh');
    expect(state.resolutions[1]?.options.promptCacheTtl).toBe('1h');
    expect(state.resolutions[1]?.options.thinkingDisplay).toBe('summarized');
  });
});
