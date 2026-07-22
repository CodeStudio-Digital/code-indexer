/**
 * Per-request thinking-budget propagation (Phase E follow-up).
 *
 * Before: a Phase-E role with `thinkingBudgetTokens: 12000` would land
 *         the value in `RoleConfig` but the runtime fell back to the
 *         provider's `defaultThinking.budget_tokens` because the budget
 *         never reached `ChatRequest`.
 *
 * After: `RunCoderOptions.thinkingBudgetTokens` → `runner.opts.thinkingBudgetTokens`
 *        → `ChatRequest.thinkingBudgetTokens` → Anthropic provider
 *        replaces the default `budget_tokens` on the outbound payload.
 *
 * This test focuses on the leaf: the Anthropic provider honours
 * `req.thinkingBudgetTokens` when present, and falls back to the
 * default when absent. The intermediate plumbing (runner → provider) is
 * static type-checked; behavioural coverage above the leaf is left to
 * `spawn-agent.test.ts` / integration tests.
 */
import { describe, expect, it } from 'vitest';
import { AnthropicChatProvider } from '@mcp/code-agent/providers/anthropic.js';
import type { ChatRequest } from '@mcp/code-agent/providers/adapter.js';

function makeProvider(captured: { body: string }, adaptive = false): AnthropicChatProvider {
  const fakeFetch: typeof fetch = async (_url, init) => {
    captured.body = typeof init?.body === 'string' ? init.body : '';
    const sse = [
      'event: message_start',
      'data: {"type":"message_start","message":{"usage":{"input_tokens":1,"output_tokens":0}}}',
      '',
      'event: message_stop',
      'data: {"type":"message_stop"}',
      '',
    ].join('\n');
    return new Response(sse, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  };
  return new AnthropicChatProvider({
    name: 'anthropic',
    authToken: 'test',
    baseURL: 'https://api.anthropic.com',
    fetch: fakeFetch,
    model: 'claude-sonnet-4-6',
    useBetaMessages: false,
    streamViaCreate: true,
    defaultThinking: adaptive
      ? { type: 'adaptive' }
      : { type: 'enabled', budget_tokens: 5000 },
  });
}

const baseReq: Omit<ChatRequest, 'thinking' | 'thinkingBudgetTokens'> = {
  system: 'sys',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  tools: [],
};

async function drain(provider: AnthropicChatProvider, req: ChatRequest): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  for await (const _ of provider.chat(req)) {
    /* consume */
  }
}

describe('AnthropicChatProvider — per-request thinking budget', () => {
  it('uses defaultThinking.budget_tokens when the request omits thinkingBudgetTokens', async () => {
    const captured = { body: '' };
    const provider = makeProvider(captured);
    await drain(provider, { ...baseReq, thinking: true });
    const sent = JSON.parse(captured.body);
    expect(sent.thinking).toEqual({ type: 'enabled', budget_tokens: 5000 });
  });

  it('overrides budget_tokens with the per-request value', async () => {
    const captured = { body: '' };
    const provider = makeProvider(captured);
    await drain(provider, { ...baseReq, thinking: true, thinkingBudgetTokens: 12000 });
    const sent = JSON.parse(captured.body);
    expect(sent.thinking).toEqual({ type: 'enabled', budget_tokens: 12000 });
  });

  it('auto-bumps max_tokens to leave 4k headroom above the per-request budget', async () => {
    const captured = { body: '' };
    const provider = makeProvider(captured);
    await drain(provider, { ...baseReq, thinking: true, thinkingBudgetTokens: 30000 });
    const sent = JSON.parse(captured.body);
    expect(sent.max_tokens).toBeGreaterThanOrEqual(34_000);
  });

  it('ignores per-request budget when thinking is off', async () => {
    const captured = { body: '' };
    const provider = makeProvider(captured);
    await drain(provider, { ...baseReq, thinking: false, thinkingBudgetTokens: 20000 });
    const sent = JSON.parse(captured.body);
    expect(sent.thinking).toBeUndefined();
  });

  it('ignores non-positive budgets (defensive: bad data shouldn\'t silently disable thinking)', async () => {
    const captured = { body: '' };
    const provider = makeProvider(captured);
    await drain(provider, { ...baseReq, thinking: true, thinkingBudgetTokens: 0 });
    const sent = JSON.parse(captured.body);
    expect(sent.thinking).toEqual({ type: 'enabled', budget_tokens: 5000 });
  });

  it('does not attach legacy budget_tokens to adaptive Claude Code thinking', async () => {
    const captured = { body: '' };
    const provider = makeProvider(captured, true);
    await drain(provider, { ...baseReq, thinking: true, thinkingBudgetTokens: 12000 });
    const sent = JSON.parse(captured.body);
    expect(sent.thinking).toEqual({ type: 'adaptive' });
  });
});
