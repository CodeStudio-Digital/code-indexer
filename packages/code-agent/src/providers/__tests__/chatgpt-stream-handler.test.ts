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

const { ChatGPTCodexProvider, toResponsesInput } = await import('../chatgpt.js');
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

  it('captures ordered encrypted continuation only after successful completion and records timing', async () => {
    const reasoning = { type: 'reasoning', id: 'rs_1', encrypted_content: 'opaque', summary: [] };
    const message = { type: 'message', id: 'msg_1', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] };
    const deltas = await collect([
      { type: 'response.created' },
      { type: 'response.output_item.done', output_index: 1, item: message },
      { type: 'response.output_item.done', output_index: 0, item: reasoning },
      { type: 'response.completed', response: { status: 'completed' } },
    ]);
    expect(mockCreate.mock.calls[0][0].include).toEqual(['reasoning.encrypted_content']);
    const replay = deltas.find((delta) => delta.type === 'provider_replay');
    expect(replay?.type === 'provider_replay' && replay.state.items).toEqual([reasoning, message]);
    expect(deltas).toContainEqual(expect.objectContaining({ type: 'response_meta', meta: expect.objectContaining({
      timing: expect.objectContaining({ transport: 'sse', first_content_ms: expect.any(Number), total_ms: expect.any(Number) }),
    }) }));
    const partial = await collect([{ type: 'response.output_item.done', item: reasoning }]);
    expect(partial.some((delta) => delta.type === 'provider_replay')).toBe(false);
  });

  it('uses low verbosity without changing high effort and excludes server-side image generation from inference-only', async () => {
    mockCreate.mockResolvedValueOnce((async function* () { yield { type: 'response.completed' }; })());
    const opts = { apiKey: 'test', baseURL: 'https://example.test', model: 'gpt-6.1-sol', textVerbosity: 'low' as const };
    const provider = new ChatGPTCodexProvider(opts);
    for await (const _delta of provider.chat({ ...request(), reasoningEffort: 'high' })) { /* consume */ }
    expect(mockCreate.mock.calls[0][0]).toMatchObject({ text: { verbosity: 'low' }, reasoning: { effort: 'high' } });
    expect(provider.inferenceOnly).toBe(true);
    expect(new ChatGPTCodexProvider({ ...opts, imageGenerationEnabled: true }).inferenceOnly).toBe(false);
    expect(new ChatGPTCodexProvider({ ...opts, codexHeaders: false }).inferenceOnly).toBe(false);
  });

  it('closes the upstream iterator at response.completed without awaiting trailing socket bytes', async () => {
    const cleaned = vi.fn();
    mockCreate.mockResolvedValueOnce((async function* () {
      try {
        yield { type: 'response.output_text.delta', delta: 'complete' };
        yield { type: 'response.completed', response: { status: 'completed' } };
        throw new TypeError('terminated');
      } finally { cleaned(); }
    })());
    const provider = new ChatGPTCodexProvider({ apiKey: 'test', baseURL: 'https://example.test', model: 'test' });
    const deltas: ChatDelta[] = [];
    for await (const delta of provider.chat(request())) deltas.push(delta);
    expect(deltas.at(-1)?.type).toBe('done');
    expect(cleaned).toHaveBeenCalledOnce();
  });

  it.each(['response.failed', 'error'])('preserves the structured code for %s', async (type) => {
    await expect(collect([{ type, error: { code: 'context_length_exceeded', message: 'Context too large' } }]))
      .rejects.toMatchObject({ code: 'context_length_exceeded' });
  });

  it('does not turn response.incomplete into a completed or blindly retryable response', async () => {
    await expect(collect([{ type: 'response.incomplete', response: { incomplete_details: { reason: 'max_output_tokens' } } }]))
      .rejects.toMatchObject({ code: 'max_output_tokens', status: 400 });
  });

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

  it('preserves the provider message item id and public phase on text deltas', async () => {
    const deltas = await collect([
      {
        type: 'response.output_item.added',
        item: { type: 'message', id: 'msg_commentary', phase: 'commentary' },
      },
      {
        type: 'response.output_text.delta',
        item_id: 'msg_commentary',
        delta: 'Vou validar o contrato agora.',
      },
    ]);

    expect(deltas).toContainEqual({
      type: 'text_delta',
      text: 'Vou validar o contrato agora.',
      itemId: 'msg_commentary',
      phase: 'commentary',
    });
  });

  it('serializes a persisted assistant phase back to Responses input', () => {
    expect(toResponsesInput([{
      role: 'assistant',
      phase: 'commentary',
      content: [{ type: 'text', text: 'Checking the backend.' }],
    }])).toEqual([{
      role: 'assistant',
      phase: 'commentary',
      content: [{ type: 'output_text', text: 'Checking the backend.' }],
    }]);
  });

  it('gates summaries on thinking while enabling supported parallel tool calls', async () => {
    mockCreate.mockResolvedValueOnce((async function* () {
      yield { type: 'response.completed', response: { status: 'completed' } };
    })());
    const provider = new ChatGPTCodexProvider({
      apiKey: 'test',
      baseURL: 'https://example.test',
      model: 'gpt-5.6-sol',
      reasoningSummary: 'auto',
      reasoningSummaryFromThinking: true,
      parallelToolCalls: true,
    });
    const req = request();
    req.thinking = false;
    req.tools = [{
      name: 'read_file',
      description: 'Read a file',
      parameters: { type: 'object', properties: {} },
    }];
    for await (const _delta of provider.chat(req)) {
      // Drain the mocked response.
    }

    const body = mockCreate.mock.calls.at(-1)![0] as Record<string, unknown>;
    expect(body).not.toHaveProperty('reasoning');
    expect(body.parallel_tool_calls).toBe(true);
  });

  it('keeps a stable cache key across GPT 6.1 provider recreation and reports reasoning without double counting', async () => {
    const req = { ...request(), sessionId: 'session-one', reasoningEffort: 'high' };
    for (let i = 0; i < 2; i++) {
      mockCreate.mockResolvedValueOnce((async function* () {
        yield { type: 'response.completed', response: { status: 'completed', usage: {
          input_tokens: 1000, output_tokens: 300,
          output_tokens_details: { reasoning_tokens: 250 },
        } } };
      })());
      const provider = new ChatGPTCodexProvider({ apiKey: 'test', baseURL: 'https://example.test', model: 'gpt-6.1-sol' });
      const deltas: ChatDelta[] = [];
      for await (const delta of provider.chat(req)) deltas.push(delta);
      expect(deltas).toContainEqual({ type: 'usage', usage: expect.objectContaining({
        input_tokens: 1000, output_tokens: 300, thinking_tokens: 250,
      }) });
      expect(mockCreate.mock.calls.at(-1)![0]).toMatchObject({
        prompt_cache_key: 'coder-session-session-one', reasoning: { effort: 'high' },
      });
    }
  });

  it('does not add Codex caching hints to a different Responses backend', async () => {
    mockCreate.mockResolvedValueOnce((async function* () { yield { type: 'response.completed' }; })());
    const provider = new ChatGPTCodexProvider({
      apiKey: 'test', baseURL: 'https://example.test', model: 'gpt-6.1-sol', codexHeaders: false,
    });
    for await (const _delta of provider.chat({ ...request(), sessionId: 'other-backend' })) { /* drain */ }
    expect(mockCreate.mock.calls.at(-1)![0]).not.toHaveProperty('prompt_cache_key');
  });
});
