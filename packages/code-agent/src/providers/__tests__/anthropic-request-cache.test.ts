import { describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  params: [] as Array<Record<string, unknown>>,
}));

vi.mock('@anthropic-ai/sdk', () => ({
  default: class FakeAnthropic {
    beta = {
      messages: {
        stream: (params: Record<string, unknown>) => {
          state.params.push(params);
          const helper = {
            on: () => helper,
            withResponse: async () => ({
              data: (async function* () {
                yield { type: 'message_stop' };
              })(),
              response: {
                status: 200,
                ok: true,
                headers: {
                  get: () => null,
                  forEach: () => undefined,
                },
              },
              request_id: 'req_cache_test',
            }),
            finalMessage: async () => ({
              usage: {
                input_tokens: 10,
                output_tokens: 1,
                cache_creation_input_tokens: 0,
                cache_read_input_tokens: 0,
              },
            }),
          };
          return helper;
        },
      },
    };
  },
}));

const {
  ANTHROPIC_EXTENDED_CACHE_TTL_BETA,
  AnthropicChatProvider,
} = await import('../anthropic.js');

describe('Anthropic request cache payload', () => {
  it('sends the one-hour cache policy on system, tools, and the newest message', async () => {
    const provider = new AnthropicChatProvider({
      apiKey: 'sk-ant-test',
      model: 'claude-sonnet-4-6',
      defaultBetas: [ANTHROPIC_EXTENDED_CACHE_TTL_BETA],
      useBetaMessages: true,
      cacheMessages: true,
      promptCacheTtl: '1h',
      fetch: vi.fn() as unknown as typeof fetch,
    });

    for await (const _delta of provider.chat({
      system: 'stable system prompt',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'first prompt' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'first answer' }] },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'second prompt' },
            { type: 'text', text: '<active-context>volatile state</active-context>' },
          ],
        },
      ],
      tools: [{
        name: 'read_file',
        description: 'Read a file',
        parameters: { type: 'object', properties: {} },
      }],
    })) {
      // Consume the complete provider stream so final usage handling also runs.
    }

    expect(state.params).toHaveLength(1);
    expect(state.params[0]).toMatchObject({
      betas: ['extended-cache-ttl-2025-04-11'],
      system: [{
        type: 'text',
        text: 'stable system prompt',
        cache_control: { type: 'ephemeral', ttl: '1h' },
      }],
      tools: [{
        name: 'read_file',
        cache_control: { type: 'ephemeral', ttl: '1h' },
      }],
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'first prompt' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'first answer' }] },
        {
          role: 'user',
          content: [{
            type: 'text',
            text: 'second prompt',
            cache_control: { type: 'ephemeral', ttl: '1h' },
          }, {
            type: 'text',
            text: '<active-context>volatile state</active-context>',
          }],
        },
      ],
    });
  });
});
