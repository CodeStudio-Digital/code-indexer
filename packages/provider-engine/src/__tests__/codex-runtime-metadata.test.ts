import { beforeEach, describe, expect, it, vi } from 'vitest';

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

vi.mock('@mcp/services/providers/shared/store.js', () => ({
  getStore: () => null,
}));

const { buildCodex } = await import('../wires/codex.js');
const { chatgptSpec } = await import('../specs/chatgpt.js');

describe('codex runtime model metadata', () => {
  beforeEach(() => {
    constructedWith.length = 0;
  });

  it.each(['gpt-5.6-sol', 'gpt-6-astra', 'gpt-6.1-sol', 'gpt-6.1-terra::deep'])(
    'allows batched function planning for %s without changing the selected model', (model) => {
      buildCodex(chatgptSpec).createCoder!({ apiKey: 'k', extra: {} }, model);
      expect(constructedWith.at(-1)).toMatchObject({
        model: model.split('::')[0], parallelToolCalls: true,
      });
    },
  );

  it('strips the host mode from the wire and selects its exact capabilities', () => {
    const wire = buildCodex(chatgptSpec);
    wire.createCoder!(
      { apiKey: 'k', extra: {} },
      'shared::deep',
      {
        providerModels: [
          {
            model_id: 'shared',
            mode: '',
            supported_reasoning_levels: ['low'],
            apply_patch_tool_type: 'function',
          },
          {
            model_id: 'shared',
            mode: 'deep',
            supported_reasoning_levels: ['low', 'xhigh'],
            default_reasoning_level: 'xhigh',
            apply_patch_tool_type: 'freeform',
          },
        ],
      },
    );

    expect(constructedWith.at(-1)).toEqual(expect.objectContaining({
      model: 'shared',
      reasoning: {
        supportedLevels: ['low', 'xhigh'],
        defaultLevel: 'xhigh',
      },
      reasoningSummary: 'auto',
      reasoningSummaryFromThinking: true,
      parallelToolCalls: false,
      applyPatchToolType: 'freeform',
    }));
  });
});
