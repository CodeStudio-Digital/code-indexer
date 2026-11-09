import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatRequest } from '@mcp/provider-sdk';
const { create, clients } = vi.hoisted(() => ({ create: vi.fn(), clients: [] as Record<string, unknown>[] }));
vi.mock('openai', () => ({ default: class {
  responses = { create };
  constructor(options: Record<string, unknown>) { clients.push(options); }
} }));
import { buildOpenAICompat } from '../wires/openai-compat.js';
import { openaiSpec } from '../specs/openai-compat.js';
import { buildOpenAICompat as buildPluginRuntime } from '@mcp/provider-runtime/wires/openai-compat.js';

beforeEach(() => {
  clients.length = 0;
  create.mockReset();
  create.mockImplementation(async () => (async function* () {
    yield { type: 'response.output_text.delta', delta: 'OK' };
    yield { type: 'response.completed', response: { id: 'resp_fixture', status: 'completed' } };
  })());
});

describe.each([['built-in', buildOpenAICompat], ['plugin runtime', buildPluginRuntime]] as const)('%s OpenAI API effort transport', (_name, build) => {
  it.each([
    ['gpt-5.5', 'high'], ['gpt-5.5-2026-04-23', 'xhigh'], ['gpt-5.5-pro', 'high'],
    ['gpt-6-astra', 'max'], ['gpt-6.1-sol', 'max'], ['gpt-6.1-terra', 'none'],
  ])('sends %s effort %s through Responses even before a catalog refresh', async (model, effort) => {
    const provider = build(openaiSpec).createCoder!({ apiKey: 'fixture-not-a-real-key', extra: {} }, model!);
    const request: ChatRequest = { system: 'fixture', messages: [{ role: 'user', content: [{ type: 'text', text: 'test' }] }],
      tools: [], thinking: true, reasoningEffort: effort };
    for await (const _delta of provider.chat(request)) { /* consume the stream */ }
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]![0]).toMatchObject({ model, reasoning: { effort, summary: 'auto' } });
    expect(clients[0]?.baseURL).toBe('https://api.openai.com/v1');
  });

  it('does not send unsupported max effort to GPT-5.5 or reasoning to GPT-4.1', async () => {
    for (const model of ['gpt-5.5', 'gpt-4.1']) {
      const provider = build(openaiSpec).createCoder!({ apiKey: 'fixture-not-a-real-key', extra: {} }, model);
      for await (const _delta of provider.chat({ system: '', messages: [], tools: [], thinking: true,
        ...(model === 'gpt-5.5' ? { reasoningEffort: 'max' } : {}) })) { /* consume */ }
    }
    expect(['low', 'medium', 'high', 'xhigh']).toContain(create.mock.calls[0]![0].reasoning.effort);
    expect(create.mock.calls[1]![0]).not.toHaveProperty('reasoning');
  });
});
