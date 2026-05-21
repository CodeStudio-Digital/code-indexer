import { describe, expect, it } from 'vitest';
import { AnthropicChatProvider } from '@mcp/code-agent/providers/anthropic.js';
import type { ChatDelta } from '@mcp/code-agent/core/messages.js';

async function collect(provider: AnthropicChatProvider): Promise<ChatDelta[]> {
  const out: ChatDelta[] = [];
  for await (const delta of provider.chat({
    system: 'test',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    tools: [],
    thinking: true,
  })) {
    out.push(delta);
  }
  return out;
}

describe('AnthropicChatProvider response metadata', () => {
  it('emits sanitized request/response stats from streaming withResponse()', async () => {
    let body = '';
    const fakeFetch: typeof fetch = async (_url, init) => {
      body = typeof init?.body === 'string' ? init.body : '';
      const sse = [
        'event: message_start',
        'data: {"type":"message_start","message":{"usage":{"input_tokens":7,"output_tokens":0,"cache_creation_input_tokens":2,"cache_read_input_tokens":3}}}',
        '',
        'event: content_block_start',
        'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
        '',
        'event: content_block_delta',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}',
        '',
        'event: content_block_stop',
        'data: {"type":"content_block_stop","index":0}',
        '',
        'event: message_delta',
        'data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":1}}',
        '',
        'event: message_stop',
        'data: {"type":"message_stop"}',
        '',
      ].join('\n');
      return new Response(sse, {
        status: 200,
        headers: {
          'content-type': 'text/event-stream',
          'request-id': 'req_meta',
          'anthropic-ratelimit-unified-status': 'allowed',
          'x-should-retry': 'false',
        },
      });
    };

    const provider = new AnthropicChatProvider({
      name: 'claude-code',
      authToken: 'test-token',
      baseURL: 'https://api.anthropic.com',
      fetch: fakeFetch,
      model: 'default',
      useBetaMessages: true,
      streamViaCreate: true,
      defaultThinking: { type: 'enabled', budget_tokens: 1024 },
      resolveModel: () => ({
        apiModel: 'claude-sonnet-4-6-20260320',
        requestedModel: 'default',
        displayModel: 'Sonnet 4.6',
        maxTokens: 4096,
        betas: ['oauth-2025-04-20'],
        thinking: { type: 'enabled', budget_tokens: 1024 },
        effort: 'high',
      }),
    });

    const deltas = await collect(provider);
    const meta = deltas.find((d) => d.type === 'response_meta');
    expect(meta?.type).toBe('response_meta');
    if (meta?.type === 'response_meta') {
      expect(meta.meta.path).toBe('/v1/messages?beta=true');
      expect(meta.meta.request?.api_model).toBe('claude-sonnet-4-6-20260320');
      expect(meta.meta.request?.requested_model).toBe('default');
      expect(meta.meta.request?.max_tokens).toBe(5120);
      expect(meta.meta.request?.stream).toBe(true);
      expect(meta.meta.request?.betas).toEqual(['oauth-2025-04-20']);
      expect(meta.meta.request?.thinking_type).toBe('enabled');
      expect(meta.meta.request?.effort).toBe('high');
      expect(meta.meta.response?.status).toBe(200);
      expect(meta.meta.response?.ok).toBe(true);
      expect(meta.meta.response?.request_id).toBe('req_meta');
      expect(meta.meta.response?.x_should_retry).toBe('false');
      expect(meta.meta.response?.rate_limits).toEqual({
        'anthropic-ratelimit-unified-status': 'allowed',
      });
    }
    expect(deltas.filter((d) => d.type === 'text_delta').map((d) => d.type === 'text_delta' ? d.text : '').join('')).toBe('ok');
    const sent = JSON.parse(body);
    expect(sent.model).toBe('claude-sonnet-4-6-20260320');
    expect(sent.max_tokens).toBe(5120);
  });
});
