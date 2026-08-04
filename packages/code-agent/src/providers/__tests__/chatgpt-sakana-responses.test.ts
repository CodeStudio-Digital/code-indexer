import { beforeEach, describe, expect, it, vi } from 'vitest';

const { clientOptions, mockCreate } = vi.hoisted(() => ({
  clientOptions: [] as Array<Record<string, unknown>>,
  mockCreate: vi.fn(),
}));

vi.mock('openai', () => ({
  default: class FakeOpenAI {
    responses = { create: mockCreate };

    constructor(opts: Record<string, unknown>) {
      clientOptions.push(opts);
    }
  },
}));

vi.mock('@mcp/shared/utils/native-fetch.js', () => ({
  nativeFetch: () => vi.fn(),
}));

const { ChatGPTCodexProvider } = await import('../chatgpt.js');
import type { ChatRequest } from '../adapter.js';
import type { ChatDelta } from '../../core/messages.js';

function request(overrides: Partial<ChatRequest> = {}): ChatRequest {
  return {
    system: 'system',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    tools: [],
    ...overrides,
  } as ChatRequest;
}

function stream(events: Array<Record<string, unknown>>): void {
  mockCreate.mockResolvedValueOnce((async function* () {
    for (const event of events) yield event;
  })());
}

function fuguProvider(model = 'fugu-ultra-v1.1'): InstanceType<typeof ChatGPTCodexProvider> {
  const isUltraV11 = model === 'fugu-ultra' || model === 'fugu-ultra-v1.1';
  return new ChatGPTCodexProvider({
    name: 'fugu',
    apiKey: 'fish_test',
    baseURL: 'https://api.sakana.ai/v1',
    model,
    reasoning: {
      supportedLevels: isUltraV11 ? ['high', 'xhigh', 'max'] : ['high', 'xhigh'],
      defaultLevel: isUltraV11 ? 'xhigh' : 'high',
    },
    codexHeaders: false,
    statefulResponses: false,
    reasoningFromThinking: false,
    reasoningSummary: 'auto',
    includeOrchestrationUsage: true,
  });
}

async function drain(
  provider: InstanceType<typeof ChatGPTCodexProvider>,
  req: ChatRequest,
): Promise<ChatDelta[]> {
  const deltas: ChatDelta[] = [];
  for await (const delta of provider.chat(req)) deltas.push(delta);
  return deltas;
}

describe('ChatGPTCodexProvider Sakana Responses profile', () => {
  beforeEach(() => {
    clientOptions.length = 0;
    mockCreate.mockReset();
    vi.unstubAllEnvs();
  });

  it('uses stateless Responses without Codex-only headers or legacy thinking mapping', async () => {
    vi.stubEnv('CODEX_STORE_RESPONSES', '1');
    stream([{ type: 'response.completed', response: { id: 'resp_1', status: 'completed' } }]);
    const provider = fuguProvider('fugu');

    const deltas = await drain(provider, request({
      thinking: true,
      previousResponseId: 'resp_previous',
      previousResponseMessageCount: 1,
      sessionId: 'session-1',
    }));

    const body = mockCreate.mock.calls.at(-1)![0] as Record<string, unknown>;
    const requestOptions = mockCreate.mock.calls.at(-1)![1] as
      | { headers?: Record<string, string> }
      | undefined;
    expect(clientOptions.at(-1)).not.toHaveProperty('defaultHeaders');
    expect(body.reasoning).toEqual({ summary: 'auto' });
    expect(body).not.toHaveProperty('store');
    expect(body).not.toHaveProperty('previous_response_id');
    expect(requestOptions?.headers).toBeUndefined();
    expect(deltas.some((delta) => delta.type === 'response_id')).toBe(false);
  });

  it('sends explicit max effort and renders streamed reasoning summaries', async () => {
    stream([
      { type: 'response.reasoning_summary_text.delta', delta: 'Inspecting the repository' },
      { type: 'response.output_text.delta', delta: 'Done' },
      { type: 'response.completed', response: { status: 'completed' } },
    ]);
    const provider = fuguProvider();

    const deltas = await drain(provider, request({ reasoningEffort: 'max' }));
    const body = mockCreate.mock.calls.at(-1)![0] as Record<string, unknown>;

    expect(body.reasoning).toEqual({ effort: 'max', summary: 'auto' });
    expect(deltas).toContainEqual({
      type: 'thinking_delta',
      text: 'Inspecting the repository',
    });
    expect(deltas).toContainEqual({ type: 'text_delta', text: 'Done' });
  });

  it('includes separately billed orchestration tokens in usage totals', async () => {
    stream([
      {
        type: 'response.completed',
        response: {
          status: 'completed',
          usage: {
            input_tokens: 120,
            output_tokens: 80,
            input_tokens_details: {
              cached_tokens: 10,
              orchestration_input_tokens: 30,
              orchestration_input_cached_tokens: 5,
            },
            output_tokens_details: {
              orchestration_output_tokens: 20,
            },
          },
        },
      },
    ]);
    const provider = fuguProvider();

    const deltas = await drain(provider, request());

    expect(deltas).toContainEqual({
      type: 'usage',
      usage: {
        input_tokens: 150,
        output_tokens: 100,
        cache_read_input_tokens: 15,
        cache_creation_input_tokens: 0,
        prompt_tokens_total: 150,
      },
    });
  });
});
