import { describe, expect, it, vi } from 'vitest';
import { OpenAIChatProvider } from '@mcp/code-agent/providers/openai.js';
import type { ChatDelta } from '@mcp/code-agent/core/messages.js';
import type { ChatRequest } from '@mcp/code-agent/providers/adapter.js';

async function* chunks(...items: Record<string, unknown>[]): AsyncIterable<Record<string, unknown>> {
  for (const item of items) yield item;
}

const baseReq: ChatRequest = {
  system: 'sys',
  messages: [],
  tools: [],
};

function makeProvider(stream: AsyncIterable<Record<string, unknown>>) {
  const provider = new OpenAIChatProvider({
    apiKey: 'or-test',
    baseURL: 'https://openrouter.ai/api/v1',
    model: 'openai/o4-mini',
    vendor: 'openrouter',
  });
  (provider as unknown as { client: unknown }).client = {
    chat: { completions: { create: vi.fn().mockResolvedValue(stream) } },
  };
  return provider;
}

function createSpy(provider: OpenAIChatProvider) {
  return (
    provider as unknown as {
      client: { chat: { completions: { create: ReturnType<typeof vi.fn> } } };
    }
  ).client.chat.completions.create;
}

async function collect(provider: OpenAIChatProvider, req: ChatRequest = baseReq): Promise<ChatDelta[]> {
  const out: ChatDelta[] = [];
  for await (const d of provider.chat(req)) out.push(d);
  return out;
}

describe('OpenAIChatProvider — OpenRouter mode', () => {
  it('sends OpenRouter reasoning when thinking is enabled', async () => {
    const provider = makeProvider(chunks({ choices: [{ delta: {}, finish_reason: 'stop' }] }));
    await collect(provider, { ...baseReq, thinking: true });
    const args = createSpy(provider).mock.calls[0][0] as Record<string, unknown>;
    expect(args.reasoning).toEqual({ enabled: true });
  });

  it('uses thinkingBudgetTokens as reasoning.max_tokens', async () => {
    const provider = makeProvider(chunks({ choices: [{ delta: {}, finish_reason: 'stop' }] }));
    await collect(provider, { ...baseReq, thinking: true, thinkingBudgetTokens: 2048 });
    const args = createSpy(provider).mock.calls[0][0] as Record<string, unknown>;
    expect(args.reasoning).toEqual({ max_tokens: 2048 });
  });

  it('streams OpenRouter reasoning deltas and usage reasoning tokens', async () => {
    const provider = makeProvider(chunks(
      { choices: [{ delta: { reasoning: 'think' } }] },
      {
        choices: [{ delta: { content: 'done' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 3, reasoning_tokens: 2 },
      },
    ));
    const deltas = await collect(provider);
    expect(deltas.find((d) => d.type === 'thinking_delta')).toEqual({
      type: 'thinking_delta',
      text: 'think',
    });
    expect(deltas.find((d) => d.type === 'usage')).toEqual({
      type: 'usage',
      usage: {
        input_tokens: 10,
        output_tokens: 3,
        cache_read_input_tokens: 0,
        thinking_tokens: 2,
        prompt_tokens_total: 10,
      },
    });
  });
});
