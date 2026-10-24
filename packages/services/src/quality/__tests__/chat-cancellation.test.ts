import { createServer } from 'node:http';
import { getEventListeners } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ResolvedBinding } from '../../pipelines/index.js';
import { openAiCompatibleChat, type ChatCallOptions, type ChatCallResult } from '../llm-chat.js';
import { anthropicChat } from '../llm-chat-anthropic.js';
import { geminiChat } from '../llm-chat-gemini.js';
import { callChatWithFailover } from '../binding-failover.js';
import { withChatRetry } from '../chat-retry.js';

function binding(id = 'local'): ResolvedBinding {
  return { pipelineName: 'snapshot_review', bindingRole: 'reviewer', bindingId: 1,
    provider: { id, name: id, kind: 'openai', api_key: 'fixture', base_url: 'http://127.0.0.1:1' },
    modelId: 'fixture', modelMode: '', config: {}, resolvedFrom: 'global' } as ResolvedBinding;
}
const success = (): ChatCallResult => ({ content: 'ok', latencyMs: 1 });
const body = { choices: [{ message: { content: 'ok' } }], content: [{ type: 'text', text: 'ok' }],
  candidates: [{ content: { parts: [{ text: 'ok' }] } }] };
const adapters = [openAiCompatibleChat, anthropicChat, geminiChat];
afterEach(() => vi.useRealTimers());

describe.each(adapters)('%s cancellation', (adapter) => {
  it('does not dispatch an already-cancelled call', async () => {
    const controller = new AbortController(); controller.abort();
    const fetchFn = vi.fn();
    const result = await adapter(binding(), [], { signal: controller.signal, fetchFn });
    expect(result.finishReason).toBe('aborted');
    expect(fetchFn).not.toHaveBeenCalled();
  });
  it('releases the parent abort listener after repeated successful calls', async () => {
    const controller = new AbortController();
    const fetchFn = vi.fn(async () => new Response(JSON.stringify(body)));
    for (let i = 0; i < 20; i++) {
      expect((await adapter(binding(), [], { signal: controller.signal, fetchFn })).content).toBe('ok');
      expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    }
  });
  it('rejects a successful body that arrives after cancellation', async () => {
    const controller = new AbortController();
    const fetchFn = vi.fn(async () => ({ ok: true, json: async () => { controller.abort(); return body; } })) as unknown as typeof fetch;
    expect(await adapter(binding(), [], { signal: controller.signal, fetchFn })).toMatchObject({ content: '', finishReason: 'aborted' });
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  });
});

describe('pipeline retry and failover cancellation', () => {
  it('clears a Retry-After backoff immediately without another provider call', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const call = vi.fn(async () => ({ content: '', errorBody: 'rate limit', status: 429, retryAfterMs: 60_000, latencyMs: 1 }));
    const pending = withChatRetry(call, { signal: controller.signal, jitter: 0 });
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(1);
    controller.abort();
    expect((await pending).finishReason).toBe('aborted');
    expect(call).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  });
  it('does not start a chain already cancelled through its retry options', async () => {
    const controller = new AbortController(); controller.abort();
    const call = vi.fn(async () => success());
    const result = await callChatWithFailover([binding()], call, { retry: { signal: controller.signal } });
    expect(result).toMatchObject({ providerCalls: 0, binding: null, result: { finishReason: 'aborted' } });
    expect(call).not.toHaveBeenCalled();
  });
  it('does not retry invalid content or fail over after caller cancellation', async () => {
    const controller = new AbortController();
    const call = vi.fn(async () => success());
    const result = await callChatWithFailover([binding('primary'), binding('fallback')], call, {
      signal: controller.signal, invalidResultRetries: 2,
      validateResult: () => { controller.abort(); return 'invalid'; },
    });
    expect(result.result.finishReason).toBe('aborted');
    expect(result.providerCalls).toBe(1);
    expect(call).toHaveBeenCalledTimes(1);
  });
  it('treats an adapter abort as terminal even without an outer signal', async () => {
    const call = vi.fn(async (): Promise<ChatCallResult> => ({ content: '', errorBody: 'rate limit', status: 429, latencyMs: 1, finishReason: 'aborted' }));
    const result = await callChatWithFailover([binding('primary'), binding('fallback')], call);
    expect(result.result.finishReason).toBe('aborted');
    expect(call).toHaveBeenCalledTimes(1);
  });
  it('does not fail over when an adapter throws AbortError', async () => {
    const call = vi.fn(async () => { throw new DOMException('aborted', 'AbortError'); });
    expect((await callChatWithFailover([binding(), binding('fallback')], call)).result.finishReason).toBe('aborted');
    expect(call).toHaveBeenCalledTimes(1);
  });
  it('drains the actual in-flight callback before reporting cancellation', async () => {
    const controller = new AbortController();
    let settle!: (result: ChatCallResult) => void;
    const call = vi.fn(() => new Promise<ChatCallResult>(resolve => { settle = resolve; }));
    let finished = false;
    const pending = callChatWithFailover([binding(), binding('fallback')], call, { signal: controller.signal }).then(r => { finished = true; return r; });
    controller.abort(); await Promise.resolve();
    expect(finished).toBe(false);
    settle(success());
    expect((await pending).result.finishReason).toBe('aborted');
    expect(call).toHaveBeenCalledTimes(1);
  });
  it('closes a real local HTTP response and never calls the fallback', async () => {
    const controller = new AbortController();
    let observed!: () => void, closed!: () => void;
    const received = new Promise<void>(resolve => { observed = resolve; });
    const disconnected = new Promise<void>(resolve => { closed = resolve; });
    let requests = 0;
    const server = createServer((req, res) => {
      requests++; req.resume();
      res.on('close', closed);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{"choices":['); observed();
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const port = (server.address() as { port: number }).port;
      const opts: ChatCallOptions = { signal: controller.signal, baseUrlOverride: `http://127.0.0.1:${port}`, timeoutMs: 2000 };
      const pending = callChatWithFailover([binding(), binding('fallback')], b => openAiCompatibleChat(b, [], opts), { signal: controller.signal });
      await received; controller.abort();
      expect((await pending).result.finishReason).toBe('aborted');
      await disconnected;
      expect(requests).toBe(1);
      expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    } finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});
