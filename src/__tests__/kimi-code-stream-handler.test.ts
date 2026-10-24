import { describe, expect, it, vi } from 'vitest';
import { KimiCodeChatProvider, toKimiMessages } from '@mcp/code-agent/providers/kimi-code.js';
import type { ChatRequest } from '@mcp/code-agent/providers/adapter.js';
import type { ChatDelta } from "@mcp/provider-sdk";

async function* chunks(...items: Record<string, unknown>[]): AsyncIterable<Record<string, unknown>> {
  for (const item of items) yield item;
}

function makeProvider(stream: AsyncIterable<Record<string, unknown>>, model = 'kimi-k2.6') {
  const provider = new KimiCodeChatProvider({
    apiKey: 'token',
    baseURL: 'https://api.kimi.com/coding/v1',
    model,
  });
  (provider as unknown as { client: unknown }).client = {
    chat: { completions: { create: vi.fn().mockResolvedValue(stream) } },
  };
  return provider;
}

const baseReq: ChatRequest = {
  system: 'sys',
  messages: [],
  tools: [
    {
      name: 'expand_toolset',
      description: 'expand tools',
      parameters: { type: 'object', properties: { tier: { enum: ['navigate'] } }, required: ['tier'] },
    },
  ],
};

const SESSION_ID = '00000000-0000-4000-8000-000000000042';

async function collect(provider: KimiCodeChatProvider, req: ChatRequest = baseReq): Promise<ChatDelta[]> {
  const out: ChatDelta[] = [];
  for await (const d of provider.chat(req)) out.push(d);
  return out;
}

function createSpy(provider: KimiCodeChatProvider) {
  return (
    provider as unknown as {
      client: { chat: { completions: { create: ReturnType<typeof vi.fn> } } };
    }
  ).client.chat.completions.create;
}

describe('KimiCodeChatProvider stream handler', () => {
  it('streams text and usage/cache tokens', async () => {
    const provider = makeProvider(chunks(
      { choices: [{ delta: { content: 'hello ' } }] },
      { choices: [{ delta: { content: 'world' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 3, cached_tokens: 4 } },
    ));

    const deltas = await collect(provider);

    expect(deltas.filter((d) => d.type === 'text_delta').map((d) => (d as { text: string }).text).join('')).toBe('hello world');
    const usage = deltas.find((d) => d.type === 'usage');
    expect(usage).toEqual({
      type: 'usage',
      usage: {
        input_tokens: 10,
        output_tokens: 3,
        cache_read_input_tokens: 4,
        prompt_tokens_total: 10,
      },
    });
  });

  it('streams reasoning_content as thinking_delta', async () => {
    const provider = makeProvider(chunks(
      { choices: [{ delta: { reasoning_content: 'thinking' } }] },
      { choices: [{ delta: { content: 'done' }, finish_reason: 'stop' }] },
    ));

    const deltas = await collect(provider);

    expect(deltas.find((d) => d.type === 'thinking_delta')).toEqual({
      type: 'thinking_delta',
      text: 'thinking',
    });
  });

  it('streams tool calls with incremental args and flushes input on finish', async () => {
    const provider = makeProvider(chunks(
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'expand_toolset', arguments: '{"tier":' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"navigate"}' } }] }, finish_reason: 'tool_calls' }] },
    ));

    const deltas = await collect(provider);
    const start = deltas.find((d) => d.type === 'tool_call_start');
    const args = deltas.filter((d) => d.type === 'tool_call_args').map((d) => (d as { partial_json: string }).partial_json);
    const end = deltas.find((d) => d.type === 'tool_call_end');

    expect(start).toEqual({ type: 'tool_call_start', id: 'call_1', name: 'expand_toolset' });
    expect(args).toEqual(['{"tier":', '"navigate"}']);
    expect(end).toEqual({
      type: 'tool_call_end',
      id: 'call_1',
      name: 'expand_toolset',
      input: { tier: 'navigate' },
    });
  });

  it('sends top-level thinking and normalized function tools', async () => {
    const provider = makeProvider(
      chunks({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
      'kimi-k2.6',
    );
    await collect(provider, { ...baseReq, thinking: true, sessionId: SESSION_ID });

    const args = createSpy(provider).mock.calls[0][0] as Record<string, unknown>;
    expect(args.stream).toBe(true);
    expect(args.stream_options).toEqual({ include_usage: true });
    expect(args.prompt_cache_key).toBe(`coder-session-${SESSION_ID}`);
    expect(args.thinking).toEqual({ type: 'enabled' });
    const tools = args.tools as Array<{ function: { parameters: Record<string, unknown> } }>;
    expect(tools[0].function.parameters.type).toBe('object');
    expect((tools[0].function.parameters.properties as Record<string, { type?: string }>).tier.type).toBe('string');
  });

  it('keeps always-thinking models enabled even when thinking=false', async () => {
    const provider = makeProvider(
      chunks({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
      'kimi-k2-thinking',
    );
    await collect(provider, { ...baseReq, thinking: false });
    const args = createSpy(provider).mock.calls[0][0] as Record<string, unknown>;
    expect(args.thinking).toEqual({ type: 'enabled' });
  });

  // Per-request `thinking` wins over the admin global `thinkingMode`. The
  // admin value is the default; the composer toggle in a chat session is
  // authoritative when the user clicks it. Same precedence applies in both
  // directions (re-enable vs force off).
  it('per-request thinking=true overrides admin thinkingMode=disabled', async () => {
    const provider = new KimiCodeChatProvider({
      apiKey: 'token',
      baseURL: 'https://api.kimi.com/coding/v1',
      model: 'kimi-k2.6',
      thinkingMode: 'disabled',
    });
    (provider as unknown as { client: unknown }).client = {
      chat: {
        completions: {
          create: vi.fn().mockResolvedValue(
            chunks({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
          ),
        },
      },
    };

    await collect(provider, { ...baseReq, thinking: true });

    const args = createSpy(provider).mock.calls[0][0] as Record<string, unknown>;
    expect(args.thinking).toEqual({ type: 'enabled' });
  });

  it('per-request thinking=false overrides admin thinkingMode=enabled', async () => {
    const provider = new KimiCodeChatProvider({
      apiKey: 'token',
      baseURL: 'https://api.kimi.com/coding/v1',
      model: 'kimi-k2.6',
      thinkingMode: 'enabled',
    });
    (provider as unknown as { client: unknown }).client = {
      chat: {
        completions: {
          create: vi.fn().mockResolvedValue(
            chunks({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
          ),
        },
      },
    };

    await collect(provider, { ...baseReq, thinking: false });

    const args = createSpy(provider).mock.calls[0][0] as Record<string, unknown>;
    expect(args.thinking).toEqual({ type: 'disabled' });
  });

  it('admin thinkingMode=enabled is honored when the request is silent', async () => {
    const provider = new KimiCodeChatProvider({
      apiKey: 'token',
      baseURL: 'https://api.kimi.com/coding/v1',
      model: 'kimi-k2.6',
      thinkingMode: 'enabled',
    });
    (provider as unknown as { client: unknown }).client = {
      chat: {
        completions: {
          create: vi.fn().mockResolvedValue(
            chunks({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
          ),
        },
      },
    };

    await collect(provider, { ...baseReq });

    const args = createSpy(provider).mock.calls[0][0] as Record<string, unknown>;
    expect(args.thinking).toEqual({ type: 'enabled' });
  });

  it('admin thinkingMode=disabled is honored when the request is silent', async () => {
    const provider = new KimiCodeChatProvider({
      apiKey: 'token',
      baseURL: 'https://api.kimi.com/coding/v1',
      model: 'kimi-k2.6',
      thinkingMode: 'disabled',
    });
    (provider as unknown as { client: unknown }).client = {
      chat: {
        completions: {
          create: vi.fn().mockResolvedValue(
            chunks({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
          ),
        },
      },
    };

    await collect(provider, { ...baseReq });

    const args = createSpy(provider).mock.calls[0][0] as Record<string, unknown>;
    expect(args.thinking).toEqual({ type: 'disabled' });
  });

  it('converts prior assistant thinking and omits empty content on tool-only assistant messages', () => {
    const messages = toKimiMessages('sys', [
      { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', text: 'reasoning' },
          { type: 'tool_use', id: 'call_1', name: 'expand_toolset', input: { tier: 'navigate' } },
        ],
      },
    ]);

    const assistant = messages.find((m) => m.role === 'assistant') as unknown as Record<string, unknown>;
    expect(assistant.reasoning_content).toBe('reasoning');
    expect(assistant.content).toBeUndefined();
    expect(assistant.tool_calls).toBeDefined();
  });

  it('converts images to image_url parts', () => {
    const messages = toKimiMessages('sys', [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'see this' },
          { type: 'image', mediaType: 'image/png', base64: 'AAA' },
        ],
      },
    ]);
    const user = messages.find((m) => m.role === 'user') as { content: Array<{ type: string; image_url?: { url: string } }> };
    expect(user.content[1]).toEqual({
      type: 'image_url',
      image_url: { url: 'data:image/png;base64,AAA' },
    });
  });
});
