import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockCreate } = vi.hoisted(() => ({ mockCreate: vi.fn() }));
vi.mock('openai', () => ({
  default: class FakeOpenAI {
    chat = { completions: { create: mockCreate } };
  },
}));

const { OpenAIChatProvider } = await import('../openai.js');
import type { ChatRequest } from '../adapter.js';

function request(): ChatRequest {
  return {
    system: 'sys',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    tools: [],
  } as ChatRequest;
}

async function drain(provider: InstanceType<typeof OpenAIChatProvider>): Promise<void> {
  mockCreate.mockResolvedValueOnce(
    (async function* () {
      yield { choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] };
    })(),
  );
  for await (const _delta of provider.chat(request())) {
    // drain
  }
}

function lastBody(): Record<string, unknown> {
  return mockCreate.mock.calls.at(-1)![0] as Record<string, unknown>;
}

describe('OpenAIChatProvider — Z.AI model output limit', () => {
  beforeEach(() => {
    mockCreate.mockReset();
    process.env.ZAI_MAX_TOKENS = '99999';
  });

  afterEach(() => {
    delete process.env.ZAI_MAX_TOKENS;
  });

  it('uses the model registry instead of the retired global env override', async () => {
    await drain(new OpenAIChatProvider({
      apiKey: 'k',
      model: 'glm-5.1',
      vendor: 'zai',
    }));
    expect(lastBody().max_tokens).toBe(16_000);
  });

  it('prefers the persisted provider-model value', async () => {
    await drain(new OpenAIChatProvider({
      apiKey: 'k',
      model: 'glm-5.1',
      vendor: 'zai',
      modelMaxOutputTokens: { 'glm-5.1': 24_000 },
    }));
    expect(lastBody().max_tokens).toBe(24_000);
  });

  it('does not add max_tokens for other OpenAI-compatible vendors', async () => {
    await drain(new OpenAIChatProvider({
      apiKey: 'k',
      model: 'gpt-4o',
      vendor: 'openai',
    }));
    expect(lastBody()).not.toHaveProperty('max_tokens');
  });
});
