import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockCreate } = vi.hoisted(() => ({ mockCreate: vi.fn() }));

vi.mock('openai', () => ({
  default: class FakeOpenAI {
    responses = { create: mockCreate };
  },
}));

vi.mock('@mcp/shared/utils/native-fetch.js', () => ({
  nativeFetch: () => vi.fn(),
}));

const { ChatGPTCodexProvider } = await import('../chatgpt.js');
import type { ChatRequest } from '../adapter.js';
import type { ChatDelta } from '../../core/messages.js';

function request(): ChatRequest {
  return {
    system: 'system',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    tools: [],
  } as ChatRequest;
}

async function collect(events: Array<Record<string, unknown>>): Promise<ChatDelta[]> {
  mockCreate.mockResolvedValueOnce((async function* () {
    for (const event of events) yield event;
  })());
  const provider = new ChatGPTCodexProvider({
    apiKey: 'test',
    baseURL: 'https://example.test',
    model: 'gpt-5.6-sol',
  });
  const deltas: ChatDelta[] = [];
  for await (const delta of provider.chat(request())) deltas.push(delta);
  return deltas;
}

describe('ChatGPTCodexProvider reasoning stream', () => {
  beforeEach(() => mockCreate.mockReset());

  it('preserves a paragraph boundary between distinct reasoning summary parts', async () => {
    const deltas = await collect([
      { type: 'response.reasoning_summary_text.delta', delta: '**Inspecting**' },
      { type: 'response.reasoning_summary_part.added' },
      { type: 'response.reasoning_summary_text.delta', delta: '**Planning**' },
    ]);

    expect(deltas.filter((delta) => delta.type === 'thinking_delta').map((delta) => delta.text).join(''))
      .toBe('**Inspecting**\n\n**Planning**');
  });

  it('does not duplicate a separator already present in the provider delta', async () => {
    const deltas = await collect([
      { type: 'response.reasoning_text.delta', delta: 'First\n' },
      { type: 'response.reasoning_part.added' },
      { type: 'response.reasoning_text.delta', delta: '\nSecond' },
    ]);

    expect(deltas.filter((delta) => delta.type === 'thinking_delta').map((delta) => delta.text).join(''))
      .toBe('First\n\nSecond');
  });
});
