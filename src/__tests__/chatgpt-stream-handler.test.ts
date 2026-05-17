/**
 * Stream-event handling tests for `ChatGPTCodexProvider`.
 *
 * Catches the regression where modern Codex backends (gpt-5.x) emit tool
 * calls and reasoning via events our provider didn't handle, leaving
 * subordinate sessions stalled with empty assistant messages.
 *
 * Strategy: stub the `responses.create` SDK method to return a hand-rolled
 * async iterable of SSE events, then run `chat()` and collect the deltas.
 */
import { describe, it, expect, vi } from 'vitest';
import { ChatGPTCodexProvider } from '@mcp/code-agent/providers/chatgpt.js';
import type { ChatRequest } from '@mcp/code-agent/providers/adapter.js';
import type { ChatDelta } from '@mcp/code-agent/core/messages.js';

async function* events(...evts: Record<string, unknown>[]): AsyncIterable<Record<string, unknown>> {
  for (const e of evts) yield e;
}

function makeProvider(stream: AsyncIterable<Record<string, unknown>>) {
  const provider = new ChatGPTCodexProvider({
    apiKey: 'tok',
    baseURL: 'https://chatgpt.com/backend-api/codex',
    accountId: 'acct',
    model: 'gpt-5.5',
  });
  // Swap the inner SDK client with a stub. Cast through unknown because the
  // real OpenAI SDK type carries far more surface than we exercise.
  (provider as unknown as { client: unknown }).client = {
    responses: { create: vi.fn().mockResolvedValue(stream) },
  };
  return provider;
}

const baseReq: ChatRequest = {
  messages: [],
  system: 'sys',
  tools: [
    {
      name: 'expand_toolset',
      description: '',
      parameters: { type: 'object', properties: {} },
    },
  ],
};

async function collect(p: ChatGPTCodexProvider): Promise<ChatDelta[]> {
  const out: ChatDelta[] = [];
  for await (const d of p.chat(baseReq)) out.push(d);
  return out;
}

describe('ChatGPTCodexProvider stream handler', () => {
  it('emits tool_call_end from output_item.done when args.delta never fires', async () => {
    // Repro of session 446 / 449: Codex backend emits the function_call
    // arguments only via the final `output_item.done` payload.
    const stream = events(
      {
        type: 'response.output_item.added',
        item: { type: 'function_call', id: 'item_1', call_id: 'call_1', name: 'expand_toolset' },
      },
      {
        type: 'response.output_item.done',
        item: {
          type: 'function_call',
          id: 'item_1',
          call_id: 'call_1',
          name: 'expand_toolset',
          arguments: '{"tier":"navigate","reason":"unzip + extract"}',
        },
      },
      { type: 'response.completed', response: { usage: { input_tokens: 10, output_tokens: 5 }, status: 'completed' } },
    );
    const deltas = await collect(makeProvider(stream));
    const end = deltas.find((d) => d.type === 'tool_call_end');
    expect(end).toBeDefined();
    if (end?.type === 'tool_call_end') {
      expect(end.id).toBe('call_1');
      expect(end.name).toBe('expand_toolset');
      expect(end.input).toEqual({ tier: 'navigate', reason: 'unzip + extract' });
    }
  });

  it('reasoning events are consumed silently (no delta leakage)', async () => {
    const stream = events(
      { type: 'response.output_item.added', item: { type: 'reasoning', id: 'r_1' } },
      { type: 'response.reasoning_summary_part.added', summary_index: 0 },
      { type: 'response.reasoning_text.delta', delta: 'thinking…' },
      { type: 'response.reasoning_summary_text.delta', delta: 'plan: x' },
      { type: 'response.output_item.done', item: { type: 'reasoning', id: 'r_1' } },
      { type: 'response.output_text.delta', delta: 'hi' },
      { type: 'response.completed', response: { usage: {}, status: 'completed' } },
    );
    const deltas = await collect(makeProvider(stream));
    const texts = deltas.filter((d) => d.type === 'text_delta').map((d) => (d as { text: string }).text);
    expect(texts).toEqual(['hi']);
    expect(deltas.find((d) => d.type === 'tool_call_end')).toBeUndefined();
  });

  it('custom_tool_call_input.delta accumulates and flushes', async () => {
    const stream = events(
      {
        type: 'response.output_item.added',
        item: { type: 'custom_tool_call', id: 'item_2', call_id: 'call_2', name: 'apply_patch' },
      },
      { type: 'response.custom_tool_call_input.delta', item_id: 'item_2', delta: '*** Begin Patch\n' },
      { type: 'response.custom_tool_call_input.delta', item_id: 'item_2', delta: '*** End Patch\n' },
      {
        type: 'response.output_item.done',
        item: {
          type: 'custom_tool_call',
          id: 'item_2',
          call_id: 'call_2',
          name: 'apply_patch',
          input: '*** Begin Patch\n*** End Patch\n',
        },
      },
      { type: 'response.completed', response: { usage: {}, status: 'completed' } },
    );
    const deltas = await collect(makeProvider(stream));
    const start = deltas.find((d) => d.type === 'tool_call_start');
    const end = deltas.find((d) => d.type === 'tool_call_end');
    expect(start).toBeDefined();
    expect(end).toBeDefined();
    if (end?.type === 'tool_call_end') {
      expect(end.name).toBe('apply_patch');
      expect(end.input).toEqual({ _raw: '*** Begin Patch\n*** End Patch\n' });
    }
  });

  it('legacy function_call_arguments.delta/done flow still works', async () => {
    const stream = events(
      {
        type: 'response.output_item.added',
        item: { type: 'function_call', id: 'i', call_id: 'c', name: 'expand_toolset' },
      },
      { type: 'response.function_call_arguments.delta', item_id: 'i', delta: '{"tier":' },
      { type: 'response.function_call_arguments.delta', item_id: 'i', delta: '"navigate"}' },
      { type: 'response.function_call_arguments.done', item_id: 'i' },
      { type: 'response.completed', response: { usage: {}, status: 'completed' } },
    );
    const deltas = await collect(makeProvider(stream));
    const end = deltas.find((d) => d.type === 'tool_call_end');
    expect(end).toBeDefined();
    if (end?.type === 'tool_call_end') {
      expect(end.input).toEqual({ tier: 'navigate' });
    }
    // tool_call_end should be emitted exactly once, not twice (output_item.done
    // never fires here, but if a later output_item.done arrives we must dedupe).
    expect(deltas.filter((d) => d.type === 'tool_call_end')).toHaveLength(1);
  });

  it('flushes pending tool calls on response.completed if neither end-event arrived', async () => {
    const stream = events(
      {
        type: 'response.output_item.added',
        item: { type: 'function_call', id: 'i', call_id: 'c', name: 'expand_toolset' },
      },
      { type: 'response.function_call_arguments.delta', item_id: 'i', delta: '{"tier":"admin"}' },
      // no .done, no output_item.done — buggy upstream
      { type: 'response.completed', response: { usage: {}, status: 'completed' } },
    );
    const deltas = await collect(makeProvider(stream));
    const end = deltas.find((d) => d.type === 'tool_call_end');
    expect(end).toBeDefined();
    if (end?.type === 'tool_call_end') {
      expect(end.input).toEqual({ tier: 'admin' });
    }
  });

  it('output_item.done dedupes against function_call_arguments.done', async () => {
    const stream = events(
      {
        type: 'response.output_item.added',
        item: { type: 'function_call', id: 'i', call_id: 'c', name: 'fn' },
      },
      { type: 'response.function_call_arguments.delta', item_id: 'i', delta: '{"a":1}' },
      { type: 'response.function_call_arguments.done', item_id: 'i' },
      // same args duplicated via output_item.done — should NOT emit twice
      {
        type: 'response.output_item.done',
        item: { type: 'function_call', id: 'i', call_id: 'c', name: 'fn', arguments: '{"a":1}' },
      },
      { type: 'response.completed', response: { usage: {}, status: 'completed' } },
    );
    const deltas = await collect(makeProvider(stream));
    expect(deltas.filter((d) => d.type === 'tool_call_end')).toHaveLength(1);
  });

  it('text deltas pass through unchanged', async () => {
    const stream = events(
      { type: 'response.output_text.delta', delta: 'hello ' },
      { type: 'response.output_text.delta', delta: 'world' },
      { type: 'response.completed', response: { usage: { input_tokens: 1, output_tokens: 2 }, status: 'completed' } },
    );
    const deltas = await collect(makeProvider(stream));
    const texts = deltas.filter((d) => d.type === 'text_delta').map((d) => (d as { text: string }).text);
    expect(texts.join('')).toBe('hello world');
  });

  // ─── P0: store + previous_response_id (opt-in via CODEX_STORE_RESPONSES=1)

  it('sends store:false by default and never previous_response_id', async () => {
    const prev = process.env.CODEX_STORE_RESPONSES;
    delete process.env.CODEX_STORE_RESPONSES;
    try {
      const stream = events(
        { type: 'response.completed', response: { id: 'resp_123', usage: {}, status: 'completed' } },
      );
      const provider = makeProvider(stream);
      const create = (
        provider as unknown as { client: { responses: { create: ReturnType<typeof vi.fn> } } }
      ).client.responses.create;

      await collect(provider);
      expect(create).toHaveBeenCalledTimes(1);
      const args = create.mock.calls[0][0] as Record<string, unknown>;
      expect(args.store).toBe(false);
      expect(args.previous_response_id).toBeUndefined();
    } finally {
      if (prev !== undefined) process.env.CODEX_STORE_RESPONSES = prev;
    }
  });

  it('with CODEX_STORE_RESPONSES=1 sends store:true and replays previous_response_id', async () => {
    const prev = process.env.CODEX_STORE_RESPONSES;
    process.env.CODEX_STORE_RESPONSES = '1';
    try {
      // Turn 1: no previousResponseId yet — full transcript, store:true.
      const provider1 = makeProvider(
        events({
          type: 'response.completed',
          response: { id: 'resp_first', usage: {}, status: 'completed' },
        }),
      );
      const create1 = (
        provider1 as unknown as { client: { responses: { create: ReturnType<typeof vi.fn> } } }
      ).client.responses.create;
      const deltas = await collect(provider1);
      const args1 = create1.mock.calls[0][0] as Record<string, unknown>;
      expect(args1.store).toBe(true);
      expect(args1.previous_response_id).toBeUndefined();
      const respId = deltas.find((d) => d.type === 'response_id');
      expect(respId).toBeDefined();

      // Turn 2: previousResponseId set → only the delta shipped.
      const provider2 = makeProvider(
        events({
          type: 'response.completed',
          response: { id: 'resp_second', usage: {}, status: 'completed' },
        }),
      );
      const create2 = (
        provider2 as unknown as { client: { responses: { create: ReturnType<typeof vi.fn> } } }
      ).client.responses.create;
      const out: ChatDelta[] = [];
      for await (const d of provider2.chat({
        ...baseReq,
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'first' }] },
          { role: 'assistant', content: [{ type: 'text', text: 'one' }] },
          { role: 'user', content: [{ type: 'text', text: 'second' }] },
        ],
        previousResponseId: 'resp_first',
        previousResponseMessageCount: 2,
      })) {
        out.push(d);
      }
      const args2 = create2.mock.calls[0][0] as Record<string, unknown>;
      expect(args2.previous_response_id).toBe('resp_first');
      const input = args2.input as Array<{ role?: string }>;
      expect(input).toHaveLength(1);
      expect(input[0].role).toBe('user');
      const r2 = out.find((d) => d.type === 'response_id');
      if (r2?.type === 'response_id') {
        expect(r2.messageCount).toBe(3);
      }
    } finally {
      if (prev !== undefined) process.env.CODEX_STORE_RESPONSES = prev;
      else delete process.env.CODEX_STORE_RESPONSES;
    }
  });

  it('ignores previousResponseId when store opt-in is off', async () => {
    const prev = process.env.CODEX_STORE_RESPONSES;
    delete process.env.CODEX_STORE_RESPONSES;
    try {
      const provider = makeProvider(
        events({ type: 'response.completed', response: { usage: {}, status: 'completed' } }),
      );
      const create = (
        provider as unknown as { client: { responses: { create: ReturnType<typeof vi.fn> } } }
      ).client.responses.create;
      const out: ChatDelta[] = [];
      for await (const d of provider.chat({
        ...baseReq,
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'a' }] },
          { role: 'assistant', content: [{ type: 'text', text: 'b' }] },
          { role: 'user', content: [{ type: 'text', text: 'c' }] },
        ],
        previousResponseId: 'resp_stale',
        previousResponseMessageCount: 2,
      })) {
        out.push(d);
      }
      const args = create.mock.calls[0][0] as Record<string, unknown>;
      expect(args.store).toBe(false);
      expect(args.previous_response_id).toBeUndefined();
      const input = args.input as Array<unknown>;
      expect(input).toHaveLength(3);
    } finally {
      if (prev !== undefined) process.env.CODEX_STORE_RESPONSES = prev;
    }
  });

  // ─── P1.5: reasoning / thinking ───────────────────────────────

  it('emits reasoning_text.delta + reasoning_summary_text.delta as thinking_delta', async () => {
    const stream = events(
      { type: 'response.reasoning_text.delta', delta: 'plan: do X' },
      { type: 'response.reasoning_summary_text.delta', delta: ' then Y' },
      { type: 'response.output_text.delta', delta: 'final answer' },
      { type: 'response.completed', response: { usage: {}, status: 'completed' } },
    );
    const deltas = await collect(makeProvider(stream));
    const thinking = deltas.filter((d) => d.type === 'thinking_delta').map((d) => (d as { text: string }).text);
    expect(thinking).toEqual(['plan: do X', ' then Y']);
    const text = deltas.filter((d) => d.type === 'text_delta').map((d) => (d as { text: string }).text);
    expect(text).toEqual(['final answer']);
  });

  it('omits reasoning field when req.thinking is undefined', async () => {
    const provider = makeProvider(
      events({ type: 'response.completed', response: { usage: {}, status: 'completed' } }),
    );
    const create = (
      provider as unknown as { client: { responses: { create: ReturnType<typeof vi.fn> } } }
    ).client.responses.create;
    await collect(provider);
    const args = create.mock.calls[0][0] as Record<string, unknown>;
    expect(args.reasoning).toBeUndefined();
  });

  it('sends reasoning.effort=high when thinking=true and capability allows', async () => {
    const provider = new ChatGPTCodexProvider({
      apiKey: 'tok',
      baseURL: 'https://chatgpt.com/backend-api/codex',
      accountId: 'a',
      model: 'gpt-5.5',
      reasoning: { supportedLevels: ['minimal', 'low', 'medium', 'high'], defaultLevel: 'medium' },
    });
    const create = vi
      .fn()
      .mockResolvedValue(
        events({ type: 'response.completed', response: { usage: {}, status: 'completed' } }),
      );
    (provider as unknown as { client: { responses: { create: typeof create } } }).client = {
      responses: { create },
    };

    const out: ChatDelta[] = [];
    for await (const d of provider.chat({ ...baseReq, thinking: true })) out.push(d);
    const args = create.mock.calls[0][0] as Record<string, unknown>;
    expect(args.reasoning).toEqual({ effort: 'high', summary: 'auto' });
  });

  it('sends reasoning.effort=minimal when thinking=false', async () => {
    const provider = new ChatGPTCodexProvider({
      apiKey: 'tok',
      baseURL: 'https://chatgpt.com/backend-api/codex',
      accountId: 'a',
      model: 'gpt-5.5',
      reasoning: { supportedLevels: ['minimal', 'low', 'medium', 'high'] },
    });
    const create = vi
      .fn()
      .mockResolvedValue(
        events({ type: 'response.completed', response: { usage: {}, status: 'completed' } }),
      );
    (provider as unknown as { client: { responses: { create: typeof create } } }).client = {
      responses: { create },
    };

    const out: ChatDelta[] = [];
    for await (const d of provider.chat({ ...baseReq, thinking: false })) out.push(d);
    const args = create.mock.calls[0][0] as Record<string, unknown>;
    expect(args.reasoning).toEqual({ effort: 'minimal', summary: 'auto' });
  });

  it('falls back to highest available when thinking=true but capability lacks high', async () => {
    const provider = new ChatGPTCodexProvider({
      apiKey: 'tok',
      baseURL: 'https://chatgpt.com/backend-api/codex',
      accountId: 'a',
      model: 'gpt-5-mini',
      reasoning: { supportedLevels: ['minimal', 'low', 'medium'] },
    });
    const create = vi
      .fn()
      .mockResolvedValue(
        events({ type: 'response.completed', response: { usage: {}, status: 'completed' } }),
      );
    (provider as unknown as { client: { responses: { create: typeof create } } }).client = {
      responses: { create },
    };

    const out: ChatDelta[] = [];
    for await (const d of provider.chat({ ...baseReq, thinking: true })) out.push(d);
    const args = create.mock.calls[0][0] as Record<string, unknown>;
    expect((args.reasoning as { effort: string }).effort).toBe('medium');
  });

  // ─── P1: image generation ────────────────────────────────────

  it('attaches image_generation tool when imageGenerationEnabled=true', async () => {
    const provider = new ChatGPTCodexProvider({
      apiKey: 'tok',
      baseURL: 'https://chatgpt.com/backend-api/codex',
      accountId: 'a',
      model: 'gpt-5.5',
      imageGenerationEnabled: true,
    });
    const create = vi
      .fn()
      .mockResolvedValue(
        events({ type: 'response.completed', response: { usage: {}, status: 'completed' } }),
      );
    (provider as unknown as { client: { responses: { create: typeof create } } }).client = {
      responses: { create },
    };

    for await (const _ of provider.chat(baseReq)) void _;
    const args = create.mock.calls[0][0] as Record<string, unknown>;
    const tools = args.tools as Array<{ type: string; output_format?: string }>;
    const imgTool = tools.find((t) => t.type === 'image_generation');
    expect(imgTool).toBeDefined();
    expect(imgTool?.output_format).toBe('png');
  });

  it('omits image_generation tool when capability is off', async () => {
    const provider = makeProvider(
      events({ type: 'response.completed', response: { usage: {}, status: 'completed' } }),
    );
    const create = (
      provider as unknown as { client: { responses: { create: ReturnType<typeof vi.fn> } } }
    ).client.responses.create;
    await collect(provider);
    const args = create.mock.calls[0][0] as Record<string, unknown>;
    const tools = args.tools as Array<{ type: string }>;
    expect(tools.find((t) => t.type === 'image_generation')).toBeUndefined();
  });

  it('emits image_generated ChatDelta from response.output_item.done with image_generation_call', async () => {
    const stream = events(
      {
        type: 'response.output_item.done',
        item: {
          type: 'image_generation_call',
          id: 'img_1',
          status: 'completed',
          revised_prompt: 'a logo',
          result: 'AAAABBBBCCCC', // base64 stub
        },
      },
      { type: 'response.completed', response: { usage: {}, status: 'completed' } },
    );
    const deltas = await collect(makeProvider(stream));
    const img = deltas.find((d) => d.type === 'image_generated');
    expect(img).toBeDefined();
    if (img?.type === 'image_generated') {
      expect(img.id).toBe('img_1');
      expect(img.mediaType).toBe('image/png');
      expect(img.base64).toBe('AAAABBBBCCCC');
      expect(img.revisedPrompt).toBe('a logo');
    }
  });

  it('parses data:image/png;base64 prefix when result is a data url', async () => {
    const stream = events(
      {
        type: 'response.output_item.done',
        item: {
          type: 'image_generation_call',
          id: 'img_2',
          status: 'completed',
          result: 'data:image/jpeg;base64,XYZ123',
        },
      },
      { type: 'response.completed', response: { usage: {}, status: 'completed' } },
    );
    const deltas = await collect(makeProvider(stream));
    const img = deltas.find((d) => d.type === 'image_generated');
    if (img?.type === 'image_generated') {
      expect(img.mediaType).toBe('image/jpeg');
      expect(img.base64).toBe('XYZ123');
    }
  });
});
