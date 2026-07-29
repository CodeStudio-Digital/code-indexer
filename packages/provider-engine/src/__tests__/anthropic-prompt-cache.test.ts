import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  constructedWith: [] as Array<Record<string, unknown>>,
}));

vi.mock('@mcp/code-agent/providers/anthropic.js', () => ({
  ANTHROPIC_EXTENDED_CACHE_TTL_BETA: 'extended-cache-ttl-2025-04-11',
  resolveAnthropicRequestModel: vi.fn(() => ({ apiModel: 'claude-opus-5' })),
  AnthropicChatProvider: class FakeAnthropicChatProvider {
    constructor(opts: Record<string, unknown>) {
      state.constructedWith.push(opts);
    }
  },
}));

const { buildAnthropic: buildHostAnthropic } = await import('../wires/anthropic.js');
const { buildAnthropic: buildPluginAnthropic } = await import(
  '../../../provider-runtime/src/wires/anthropic.js'
);
const { anthropicSpec } = await import('../specs/anthropic.js');

describe('Anthropic prompt cache policy', () => {
  beforeEach(() => {
    state.constructedWith.length = 0;
  });

  it.each([
    ['host', buildHostAnthropic],
    ['plugin runtime', buildPluginAnthropic],
  ])('enables moving one-hour cache breakpoints in the %s wire', (_name, build) => {
    const wire = build(anthropicSpec);
    wire.createCoder!({ apiKey: 'sk-ant-test', extra: {} }, 'claude-sonnet-4-6');

    expect(state.constructedWith.at(-1)).toMatchObject({
      model: 'claude-sonnet-4-6',
      defaultBetas: ['extended-cache-ttl-2025-04-11'],
      useBetaMessages: true,
      cacheMessages: true,
      promptCacheTtl: '1h',
    });
  });
});
