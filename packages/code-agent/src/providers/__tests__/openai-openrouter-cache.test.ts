import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  constructorOptions: [] as Array<Record<string, unknown>>,
}));

vi.mock('openai', () => ({
  default: class FakeOpenAI {
    chat = { completions: { create: mocks.create } };
    constructor(options: Record<string, unknown>) {
      mocks.constructorOptions.push(options);
    }
  },
}));

const { OpenAIChatProvider } = await import('../openai.js');
import type {
  ChatProvider,
  ChatRequest,
  ProviderAttemptTelemetry,
} from '../adapter.js';

function request(overrides: Partial<ChatRequest> = {}): ChatRequest {
  return {
    system: 'system',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    tools: [],
    sessionId: 42,
    ...overrides,
  };
}

async function drain(provider: ChatProvider, req: ChatRequest): Promise<void> {
  for await (const _delta of provider.chat(req)) {
    // Drain.
  }
}

describe('OpenAIChatProvider — OpenRouter cache affinity and attempts', () => {
  beforeEach(() => {
    mocks.create.mockReset();
    mocks.constructorOptions.length = 0;
  });

  it('uses documented session_id and disables SDK retries for OpenRouter', async () => {
    mocks.create.mockResolvedValueOnce((async function* () {
      yield { id: 'gen-1', choices: [{ delta: {}, finish_reason: 'stop' }] };
    })());
    const provider = new OpenAIChatProvider({
      apiKey: 'test',
      baseURL: 'https://openrouter.ai/api/v1',
      model: 'moonshotai/kimi-k3',
      vendor: 'openrouter',
    });

    await drain(provider, request());

    expect(mocks.constructorOptions.at(-1)).toMatchObject({ maxRetries: 0 });
    expect(mocks.create.mock.calls[0]?.[0]).toMatchObject({
      session_id: 'coder-session-42',
    });
    expect(mocks.create.mock.calls[0]?.[0]).not.toHaveProperty('prompt_cache_key');
  });

  it('keeps prompt_cache_key for the native OpenAI wire', async () => {
    mocks.create.mockResolvedValueOnce((async function* () {
      yield { id: 'chatcmpl-1', choices: [{ delta: {}, finish_reason: 'stop' }] };
    })());
    const provider = new OpenAIChatProvider({
      apiKey: 'test',
      model: 'gpt-4o',
      vendor: 'openai',
    });

    await drain(provider, request());

    expect(mocks.constructorOptions.at(-1)).toMatchObject({ maxRetries: 0 });
    expect(mocks.create.mock.calls[0]?.[0]).toMatchObject({
      prompt_cache_key: 'coder-session-42',
    });
    expect(mocks.create.mock.calls[0]?.[0]).not.toHaveProperty('session_id');
  });

  it('reports successful generation, usage, cache and exact provider cost', async () => {
    mocks.create.mockResolvedValueOnce((async function* () {
      yield {
        id: 'gen-success',
        provider: 'Moonshot AI',
        choices: [{ delta: { content: 'ok' }, finish_reason: null }],
      };
      yield {
        id: 'gen-success',
        choices: [{ delta: {}, finish_reason: 'stop' }],
        usage: {
          prompt_tokens: 16_000,
          completion_tokens: 100,
          prompt_tokens_details: { cached_tokens: 15_500 },
          cost: 0.008,
        },
      };
    })());
    const attempts: ProviderAttemptTelemetry[] = [];
    const provider = new OpenAIChatProvider({
      apiKey: 'test',
      model: 'moonshotai/kimi-k3',
      vendor: 'openrouter',
    });

    await drain(provider, request({
      onAttempt: (attempt) => {
        attempts.push(attempt);
      },
    }));

    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({
      status: 200,
      ok: true,
      generationId: 'gen-success',
      requestId: null,
      upstreamProvider: 'Moonshot AI',
      inputTokens: 16_000,
      outputTokens: 100,
      cachedTokens: 15_500,
      costUsd: 0.008,
    });
  });

  it('reports a failed upstream request before rethrowing it', async () => {
    const secret = 'SECRET-SENTINEL-PROVIDER-MESSAGE';
    const error = Object.assign(new Error(`rate limited ${secret}`), {
      status: 429,
      code: 'rate_limit',
      request_id: 'req-429',
      headers: new Headers({
        'x-generation-id': 'gen-429',
        'retry-after': '2',
      }),
    });
    mocks.create.mockRejectedValueOnce(error);
    const attempts: ProviderAttemptTelemetry[] = [];
    const provider = new OpenAIChatProvider({
      apiKey: 'test',
      model: 'moonshotai/kimi-k3',
      vendor: 'openrouter',
    });

    await expect(drain(
      provider,
      request({
        onAttempt: (attempt) => {
          attempts.push(attempt);
        },
      }),
    )).rejects.toThrow('rate limited');

    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({
      status: 429,
      ok: false,
      generationId: 'gen-429',
      requestId: 'req-429',
      retryAfter: '2',
      errorCode: 'rate_limit',
    });
    expect(attempts[0]?.errorMessage).toMatch(/^Error:sha256:[a-f0-9]{64}$/);
    expect(JSON.stringify(attempts[0])).not.toContain(secret);
  });

  it('reports EOF without finish_reason as failure rather than a false 200 success', async () => {
    mocks.create.mockResolvedValueOnce((async function* () {
      yield {
        id: 'gen-truncated',
        choices: [{ delta: { content: 'partial' }, finish_reason: null }],
      };
    })());
    const attempts: ProviderAttemptTelemetry[] = [];
    const provider = new OpenAIChatProvider({
      apiKey: 'test',
      model: 'gpt-4o',
      vendor: 'openai',
    });

    await drain(provider, request({
      onAttempt: (attempt) => {
        attempts.push(attempt);
      },
    }));

    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({
      status: null,
      ok: false,
      generationId: 'gen-truncated',
      requestId: null,
      errorCode: 'STREAM_ENDED_NO_TERMINAL',
      errorMessage: 'ProviderStreamProtocolError:stream-ended-no-terminal',
    });
  });
});
