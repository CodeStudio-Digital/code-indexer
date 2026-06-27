/**
 * `callGeneralAiJson` must delegate the actual LLM call to the shared
 * provider engine (`createCoderProvider`) so utility AI tasks (commit
 * message, pipeline-generate, script-assist) inherit every provider
 * routing detail — notably Z.AI's `extra.zai_mode='coding'` endpoint.
 * Before this, it built its own OpenAI/Anthropic client that ignored the
 * coding-plan flag and hit the pay-as-you-go endpoint (429).
 *
 * No real provider/network here: the engine is mocked and we assert (a)
 * the stream's text_delta chunks are concatenated into `raw`, (b) the
 * engine is called with the resolved providerId + modelId, and (c) the
 * "not configured" path still returns a stable refusal string.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { ChatDelta } from '@mcp/provider-sdk';

const engine = vi.hoisted(() => ({ createCoderProvider: vi.fn() }));

vi.mock('@mcp/services/providers/factory.js', () => ({
  createCoderProvider: engine.createCoderProvider,
}));

const { callGeneralAiJson } = await import('../aiJson.js');

function fakeProvider(chunks: ChatDelta[]) {
  return {
    name: 'fake',
    model: 'm',
    setModel() {},
    async *chat() {
      for (const c of chunks) yield c;
    },
  };
}

/** Minimal ProviderStore surface `callGeneralAiJson` touches. */
function deps(store: Record<string, unknown>) {
  return { providerStore: store } as never;
}

beforeEach(() => engine.createCoderProvider.mockReset());

describe('callGeneralAiJson', () => {
  it('delegates to the engine and concatenates text_delta chunks', async () => {
    engine.createCoderProvider.mockResolvedValue(
      fakeProvider([
        { type: 'text_delta', text: 'feat: ' },
        { type: 'text_delta', text: 'add thing' },
        { type: 'done' },
      ]),
    );

    const res = await callGeneralAiJson(
      deps({
        getGeneralDefault: () => ({ providerId: 'zai', modelId: 'glm-5.1' }),
        getProvider: () => ({ kind: 'zai', api_key: 'k', enabled: true }),
      }),
      { system: 's', user: 'u' },
    );

    expect(res).toEqual({ raw: 'feat: add thing' });
    expect(engine.createCoderProvider).toHaveBeenCalledWith('zai', 'glm-5.1');
  });

  it('falls back to the first usable enabled provider when no default', async () => {
    engine.createCoderProvider.mockResolvedValue(
      fakeProvider([{ type: 'text_delta', text: 'ok' }, { type: 'done' }]),
    );

    const res = await callGeneralAiJson(
      deps({
        getGeneralDefault: () => null,
        getProvider: () => null,
        listProviders: () => [{ id: 'oai', kind: 'openai', api_key: 'k', enabled: true }],
        listModels: () => [{ model_id: 'gpt-x' }],
      }),
      { system: 's', user: 'u' },
    );

    expect(res).toEqual({ raw: 'ok' });
    expect(engine.createCoderProvider).toHaveBeenCalledWith('oai', 'gpt-x');
  });

  it('refuses (stable string) when nothing is configured', async () => {
    const res = await callGeneralAiJson(
      deps({
        getGeneralDefault: () => null,
        getProvider: () => null,
        listProviders: () => [],
      }),
      { system: 's', user: 'u' },
    );

    expect(res).toEqual({ refusal: expect.stringMatching(/no usable ai provider/i) });
    expect(engine.createCoderProvider).not.toHaveBeenCalled();
  });

  it('wraps engine errors into a refusal instead of throwing', async () => {
    // Error originates from the stream (a real mid-call failure like a 429),
    // not from the spy itself — so the function's try/catch is what's exercised.
    engine.createCoderProvider.mockResolvedValue({
      name: 'fake',
      model: 'm',
      setModel() {},
      // eslint-disable-next-line require-yield
      async *chat() {
        throw new Error('429 Insufficient balance');
      },
    });

    const res = await callGeneralAiJson(
      deps({
        getGeneralDefault: () => ({ providerId: 'zai', modelId: 'glm-5.1' }),
        getProvider: () => ({ kind: 'zai', api_key: 'k', enabled: true }),
      }),
      { system: 's', user: 'u' },
    );

    expect(res).toEqual({ refusal: expect.stringContaining('429 Insufficient balance') });
  });
});
