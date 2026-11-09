import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AnthropicChatProvider } from '../anthropic.js';
import { consumeStream } from '../../core/runner/nodes/executing-stream.js';

beforeEach(() => vi.useFakeTimers({ toFake: ['Date', 'performance', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] }));
afterEach(() => vi.useRealTimers());

/** Actual Anthropic SDK + SSE parser; only fetch and elapsed time are synthetic. */
function fixture(mode: 'thinking' | 'ping' | 'silent') {
  const encoder = new TextEncoder();
  const cancelled = vi.fn();
  let timer: ReturnType<typeof setInterval> | undefined;
  const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const signal = init?.signal;
    let onAbort: () => void;
    const cleanup = () => {
      if (timer) clearInterval(timer);
      signal?.removeEventListener('abort', onAbort);
      cancelled();
    };
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        const send = (type: string, extra = {}) => controller.enqueue(encoder.encode(`event: ${type}\ndata: ${JSON.stringify({ type, ...extra })}\n\n`));
        onAbort = () => { cleanup(); controller.error(new DOMException('Aborted', 'AbortError')); };
        signal?.addEventListener('abort', onAbort, { once: true });
        send('message_start', { message: { id: 'msg_fixture', role: 'assistant', type: 'message', model: 'claude-opus-4-6', content: [], stop_reason: null, stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 0, cache_creation_input_tokens: 2, cache_read_input_tokens: 3 } } });
        send('content_block_start', { index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } });
        send('content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: 'Considering the task. ' } });
        if (mode === 'silent') return;
        let count = 0;
        timer = setInterval(() => {
          if (++count <= 20) {
            if (mode === 'thinking') send('content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: `Step ${count}. ` } });
            else send('ping'); // The installed SDK discards these before yielding any event.
            return;
          }
          clearInterval(timer);
          send('content_block_delta', { index: 0, delta: { type: 'signature_delta', signature: 'encrypted-not-user-visible' } });
          send('content_block_stop', { index: 0 });
          send('content_block_start', { index: 1, content_block: { type: 'text', text: '' } });
          send('content_block_delta', { index: 1, delta: { type: 'text_delta', text: 'Completed successfully.' } });
          send('content_block_stop', { index: 1 });
          send('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 12 } });
          send('message_stop');
          // Deliberately keep the socket open: message_stop must commit the answer.
        }, 30_000);
      },
      cancel() { cleanup(); },
    }), { headers: { 'content-type': 'text/event-stream', 'request-id': 'req_fixture' } });
  }) as unknown as typeof fetch;
  return { fetcher, cancelled };
}

describe.each([
  { useBetaMessages: false, streamViaCreate: false },
  { useBetaMessages: true, streamViaCreate: false },
  { useBetaMessages: false, streamViaCreate: true },
  { useBetaMessages: true, streamViaCreate: true },
])('Anthropic SSE liveness %o', options => {
  it.each(['thinking', 'ping'] as const)('allows ten minutes of %s and finishes at message_stop with an open socket', async mode => {
    const { fetcher, cancelled } = fixture(mode);
    const provider = new AnthropicChatProvider({ apiKey: 'synthetic-key', fetch: fetcher, ...options });
    const controller = new AbortController();
    let activity: number | undefined;
    const request = { system: '', messages: [], tools: [], signal: controller.signal, onTransportActivity: () => { activity = performance.now(); } };
    const pending = consumeStream({ stream: provider.chat(request), lastTransportActivityAt: () => activity, cancelStream: reason => controller.abort(reason) });
    const verified = expect(pending).resolves.toMatchObject({ textBlocks: ['Completed successfully.'], usage: { input_tokens: 10, output_tokens: 12, prompt_tokens_total: 15 } });
    await vi.advanceTimersByTimeAsync(21 * 30_000);
    await verified;
    expect(fetcher).toHaveBeenCalledOnce();
    expect(cancelled).toHaveBeenCalled();
    expect(JSON.stringify(await pending)).not.toContain('encrypted-not-user-visible');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels a silent transport on inactivity and cancels the SDK request on user stop', async () => {
    for (const stop of ['idle', 'user']) {
      const { fetcher, cancelled } = fixture('silent');
      const provider = new AnthropicChatProvider({ apiKey: 'synthetic-key', fetch: fetcher, ...options });
      const controller = new AbortController();
      let activity: number | undefined;
      const pending = consumeStream({
        stream: provider.chat({ system: '', messages: [], tools: [], signal: controller.signal, onTransportActivity: () => { activity = performance.now(); } }),
        signal: controller.signal, lastTransportActivityAt: () => activity, cancelStream: reason => controller.abort(reason),
      });
      const verified = expect(pending).rejects.toMatchObject({ code: stop === 'user' ? 'ABORTED' : 'TIMEOUT' });
      await vi.advanceTimersByTimeAsync(1);
      if (stop === 'user') controller.abort();
      else await vi.advanceTimersByTimeAsync(90_000);
      await verified;
      await vi.advanceTimersByTimeAsync(0);
      expect(cancelled).toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    }
  });
});

it('isolates transport activity and cancellation for concurrent calls on one provider', async () => {
  const active = fixture('ping'), silent = fixture('silent');
  let call = 0;
  const fetcher = ((...args: Parameters<typeof fetch>) => (++call === 1 ? active.fetcher : silent.fetcher)(...args)) as typeof fetch;
  const provider = new AnthropicChatProvider({ apiKey: 'synthetic-key', fetch: fetcher });
  const start = () => {
    const controller = new AbortController();
    let activity: number | undefined;
    return consumeStream({
      stream: provider.chat({ system: '', messages: [], tools: [], signal: controller.signal, onTransportActivity: () => { activity = performance.now(); } }),
      lastTransportActivityAt: () => activity, cancelStream: reason => controller.abort(reason),
    });
  };
  const activeResult = expect(start()).resolves.toMatchObject({ textBlocks: ['Completed successfully.'] });
  const silentResult = expect(start()).rejects.toMatchObject({ code: 'TIMEOUT' });
  await vi.advanceTimersByTimeAsync(90_000);
  await silentResult;
  expect(silent.cancelled).toHaveBeenCalled();
  expect(active.cancelled).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(21 * 30_000);
  await activeResult;
  expect(active.cancelled).toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});
