import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockCreate } = vi.hoisted(() => ({ mockCreate: vi.fn() }));
vi.mock('openai', () => ({
  default: class FakeOpenAI {
    chat = { completions: { create: mockCreate } };
  },
}));

const { OpenAIChatProvider } = await import('../openai.js');
import type { ChatRequest } from '../adapter.js';

function request(overrides: Partial<ChatRequest> = {}): ChatRequest {
  return {
    system: 'sys',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    tools: [],
    ...overrides,
  } as ChatRequest;
}

async function bodyFor(model: string, overrides: Partial<ChatRequest> = {}) {
  mockCreate.mockResolvedValueOnce((async function* () {
    yield { choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] };
  })());
  const provider = new OpenAIChatProvider({ apiKey: 'test', model, vendor: 'openai' });
  for await (const _delta of provider.chat(request(overrides))) {
    // Drain the request.
  }
  return mockCreate.mock.calls.at(-1)![0] as Record<string, unknown>;
}

describe('OpenAIChatProvider — legacy Kimi K3 compatibility', () => {
  beforeEach(() => mockCreate.mockReset());

  it('forces temperature 1 over a persisted user override', async () => {
    const body = await bodyFor('k3', { inference: { temperature: 0.2 } });
    expect(body.temperature).toBe(1);
  });

  it('sends temperature 1 when no override exists', async () => {
    const body = await bodyFor('k3');
    expect(body.temperature).toBe(1);
  });

  it('forwards K3 reasoning effort on the compatibility wire', async () => {
    const body = await bodyFor('k3', { reasoningEffort: 'max' });
    expect(body.reasoning_effort).toBe('max');
  });

  it('preserves generic OpenAI temperature behavior for other models', async () => {
    const body = await bodyFor('custom-model', { inference: { temperature: 0.2 } });
    expect(body.temperature).toBe(0.2);
    expect(body).not.toHaveProperty('reasoning_effort');
  });
});
