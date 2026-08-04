import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderSpec } from '@mcp/provider-sdk';

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

vi.mock('../wire-helpers/claude-code.js', () => ({
  getClaudeCodeSystemPrefixBlocks: () => [],
  resolveClaudeCodeModel: (model: string, _account: unknown, options: Record<string, unknown>) => {
    state.resolutions.push({ model, options });
    return {
      apiModel: model,
      requestedModel: model,
      displayModel: model,
      maxTokens: 128_000,
      betas: [],
      thinking: {
        type: 'adaptive',
        ...(options.thinkingDisplay ? { display: options.thinkingDisplay } : {}),
      },
      outputConfig: options.effort ? { effort: options.effort } : undefined,
      effort: options.effort ?? null,
    };
  },
}));

const { buildClaudeCode } = await import('../wires/claude-code.js');

const claudeCodeSpec: ProviderSpec = {
  kind: 'claude-code',
  displayName: 'Claude Code (OAuth)',
  credKind: 'oauth',
  envVars: [],
  defaultModels: ['fable'],
  defaultModel: 'fable',
  pricing: {},
  wire: 'anthropic',
  wireOpts: { claudeCode: true },
};

describe('provider-runtime Claude Code reasoning visibility', () => {
  beforeEach(() => {
    state.constructedWith.length = 0;
    state.resolutions.length = 0;
  });

  it('requests summarized adaptive thinking initially and on every model resolution', () => {
    const wire = buildClaudeCode(claudeCodeSpec);
    wire.createCoder!(
      { authToken: 'token', extra: {} },
      'fable',
      { providerModels: [{ model_id: 'fable', default_reasoning_level: 'high' }] },
    );

    expect(state.resolutions[0]?.options).toMatchObject({
      thinking: true,
      thinkingDisplay: 'summarized',
      effort: 'high',
    });

    const resolveModel = state.constructedWith.at(-1)?.resolveModel as (
      model: string,
      req: Record<string, unknown>,
    ) => { thinking?: Record<string, unknown> };
    const resolved = resolveModel('fable', { tools: [], reasoningEffort: 'xhigh' });

    expect(state.resolutions[1]?.options).toMatchObject({
      thinking: true,
      thinkingDisplay: 'summarized',
      effort: 'xhigh',
    });
    expect(resolved.thinking).toEqual({ type: 'adaptive', display: 'summarized' });
  });
});
