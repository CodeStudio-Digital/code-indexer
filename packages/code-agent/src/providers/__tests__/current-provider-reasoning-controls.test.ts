import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatRequest } from '../adapter.js';
import type { ChatDelta } from '../../core/messages.js';

const { mockCreate } = vi.hoisted(() => ({ mockCreate: vi.fn() }));
vi.mock('openai', () => ({
  default: class FakeOpenAI {
    chat = { completions: { create: mockCreate } };
  },
}));

const { OpenAIChatProvider } = await import('../openai.js');

function request(overrides: Partial<ChatRequest> = {}): ChatRequest {
  return {
    system: 'sys',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    tools: [],
    ...overrides,
  } as ChatRequest;
}

function simpleStream(): AsyncIterable<unknown> {
  return (async function* () {
    yield { choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] };
  })();
}

async function run(
  vendor: 'deepseek' | 'mistral' | 'copilot' | 'openrouter',
  model: string,
  overrides: Partial<ChatRequest>,
  stream: AsyncIterable<unknown> = simpleStream(),
): Promise<{ body: Record<string, unknown>; deltas: ChatDelta[] }> {
  mockCreate.mockResolvedValueOnce(stream);
  const provider = new OpenAIChatProvider({ apiKey: 'key', model, vendor });
  const deltas: ChatDelta[] = [];
  for await (const delta of provider.chat(request(overrides))) deltas.push(delta);
  return {
    body: mockCreate.mock.calls.at(-1)![0] as Record<string, unknown>,
    deltas,
  };
}

describe('current OpenAI-compatible reasoning controls', () => {
  beforeEach(() => mockCreate.mockReset());

  it('maps DeepSeek xhigh to max and enables thinking explicitly', async () => {
    const { body } = await run('deepseek', 'deepseek-v4-pro', {
      thinking: true,
      reasoningEffort: 'xhigh',
    });
    expect(body).toMatchObject({
      thinking: { type: 'enabled' },
      reasoning_effort: 'max',
    });
  });

  it('can disable DeepSeek thinking without inventing an effort', async () => {
    const { body } = await run('deepseek', 'deepseek-v4-flash', {
      thinking: false,
      reasoningEffort: 'none',
    });
    expect(body.thinking).toEqual({ type: 'disabled' });
    expect(body).not.toHaveProperty('reasoning_effort');
  });

  it('maps the boolean Mistral control to high/none', async () => {
    expect((await run('mistral', 'mistral-small-latest', { thinking: true })).body)
      .toHaveProperty('reasoning_effort', 'high');
    expect((await run('mistral', 'mistral-small-latest', { thinking: false })).body)
      .toHaveProperty('reasoning_effort', 'none');
  });

  it('forwards Copilot discrete reasoning effort', async () => {
    const { body } = await run('copilot', 'gpt-5.6-terra', {
      reasoningEffort: 'max',
    });
    expect(body.reasoning_effort).toBe('max');
  });

  it('does not invent high effort for Copilot models with model-managed reasoning', async () => {
    const { body } = await run('copilot', 'gemini-3.5-flash', {
      thinking: true,
      reasoningEffort: 'max',
    });
    expect(body).not.toHaveProperty('reasoning_effort');
  });

  it('maps the Copilot boolean toggle to high for configurable Gemini 3.6', async () => {
    const { body } = await run('copilot', 'gemini-3.6-flash', {
      thinking: true,
    });
    expect(body.reasoning_effort).toBe('high');
  });

  it('keeps OpenRouter reasoning visible and surfaces reasoning_details', async () => {
    const stream = (async function* () {
      yield {
        choices: [{
          delta: { reasoning_details: [{ type: 'reasoning.text', text: 'route thought' }] },
          finish_reason: 'stop',
        }],
      };
    })();
    const { body, deltas } = await run(
      'openrouter',
      'anthropic/claude-sonnet-5',
      { reasoningEffort: 'high' },
      stream,
    );
    expect(body.reasoning).toEqual({ effort: 'high', exclude: false });
    expect(deltas).toContainEqual({ type: 'thinking_delta', text: 'route thought' });
  });

  it('surfaces Mistral ThinkChunk and TextChunk stream parts separately', async () => {
    const stream = (async function* () {
      yield {
        choices: [{
          delta: {
            content: [
              { type: 'thinking', thinking: [{ type: 'text', text: 'reason' }] },
              { type: 'text', text: 'answer' },
            ],
          },
          finish_reason: 'stop',
        }],
      };
    })();
    const { deltas } = await run('mistral', 'mistral-medium-3-5', { thinking: true }, stream);
    expect(deltas).toContainEqual({ type: 'thinking_delta', text: 'reason' });
    expect(deltas).toContainEqual({ type: 'text_delta', text: 'answer' });
  });
});
