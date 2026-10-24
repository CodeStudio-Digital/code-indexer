import { describe, expect, it, vi } from 'vitest';
import type { ChatDelta } from '@mcp/provider-sdk/wire.js';
import { coalesceProviderDeltas } from '../provider-gateway/ProviderDeltaCoalescer.js';
import { DEFAULT_PROVIDER_GATEWAY_LIMITS as limits } from '../provider-gateway/ProviderGatewayTypes.js';

describe('provider delta coalescing', () => {
  it('preserves the first delta, exact text and content boundaries with bounded batches', async () => {
    const input: ChatDelta[] = [
      ...Array.from({ length: 1_000 }, (): ChatDelta => ({ type: 'text_delta', text: 'á🦀', itemId: 'a', phase: 'commentary' })),
      { type: 'text_delta', text: 'final', itemId: 'a', phase: 'final_answer' },
      { type: 'text_delta', text: 'other item', itemId: 'b', phase: 'final_answer' },
      { type: 'thinking_delta', text: 'think' }, { type: 'thinking_delta', text: ' more' },
      { type: 'tool_call_start', id: 'tool', name: 'read' },
      { type: 'tool_call_end', id: 'tool', name: 'read', input: {} },
      { type: 'usage', usage: { input_tokens: 2, output_tokens: 1 } }, { type: 'done' },
    ];
    const output = await collect(input);
    expect(output[0]).toEqual(input[0]);
    const text = output.filter(delta => delta.type === 'text_delta');
    expect(text.map(delta => delta.text).join('')).toBe('á🦀'.repeat(1_000) + 'finalother item');
    expect(text.length).toBeLessThan(20);
    expect(output.slice(-7)).toEqual(input.slice(-7));
    expect(input[1]).toEqual(input[0]); // no mutation of SDK-owned deltas
    expect(text.every(delta => Buffer.byteLength(delta.text) <= 16 * 1024)).toBe(true);
  });

  it('flushes buffered text while the next provider event is still pending', async () => {
    vi.useFakeTimers();
    const pending = deferred<IteratorResult<ChatDelta>>();
    let calls = 0;
    const iterator = { next: vi.fn(() => ++calls <= 2
      ? Promise.resolve({ done: false as const, value: { type: 'text_delta' as const, text: String(calls) } }) : pending.promise) };
    const controller = new AbortController();
    const stream = coalesceProviderDeltas(iterator, controller.signal, limits);
    try {
      expect((await stream.next()).value).toEqual({ type: 'text_delta', text: '1' });
      const second = stream.next();
      await vi.advanceTimersByTimeAsync(20);
      expect((await second).value).toEqual({ type: 'text_delta', text: '2' });
      expect(iterator.next).toHaveBeenCalledTimes(3);
      pending.resolve({ done: true, value: undefined });
      expect((await stream.next()).done).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally { controller.abort(); vi.useRealTimers(); }
  });

  it('bounds producer read-ahead when the consumer is slow', async () => {
    let produced = 0;
    const raw = (async function* (): AsyncGenerator<ChatDelta, void> { for (;;) { produced++; yield { type: 'text_delta', text: 'x' }; } })();
    const stream = coalesceProviderDeltas(raw, new AbortController().signal, limits);
    await stream.next();
    expect(produced).toBe(1);
    await stream.next();
    expect(produced).toBeLessThanOrEqual(257);
    const stopped = produced;
    await new Promise(resolve => setImmediate(resolve));
    expect(produced).toBe(stopped);
    await stream.return(undefined); await raw.return(undefined);
  });

  it('counts raw deltas before merging and preserves already accepted text on failure', async () => {
    const raw = from(Array.from({ length: 10 }, (): ChatDelta => ({ type: 'text_delta', text: 'x' })));
    const output: ChatDelta[] = [];
    await expect((async () => {
      for await (const delta of coalesceProviderDeltas(raw, new AbortController().signal, { ...limits, maxStreamEvents: 3 })) output.push(delta);
    })()).rejects.toMatchObject({ code: 'provider_stream_limit_exceeded' });
    expect(output.map(delta => delta.type === 'text_delta' && delta.text).join('')).toBe('xxx');
  });

  it('rejects oversized raw UTF-8 deltas and does not hide empty deltas', async () => {
    await expect(collect([{ type: 'text_delta', text: '🦀🦀' }], 7)).rejects.toMatchObject({ code: 'provider_stream_limit_exceeded' });
    const input: ChatDelta[] = [{ type: 'text_delta', text: 'a' }, { type: 'text_delta', text: '' }, { type: 'done' }];
    expect(await collect(input)).toEqual(input);
  });

  it('aborts a pending lookahead without a late text or unhandled rejection', async () => {
    const controller = new AbortController();
    const entered = deferred<void>();
    let count = 0;
    const iterator = { next: async (): Promise<IteratorResult<ChatDelta>> => {
      if (++count <= 2) return { done: false, value: { type: 'text_delta', text: 'x' } };
      entered.resolve(); return new Promise(() => {});
    } };
    const stream = coalesceProviderDeltas(iterator, controller.signal, limits);
    await stream.next();
    const second = stream.next();
    const rejection = expect(second).rejects.toThrow('cancel fixture');
    await entered.promise; controller.abort(new Error('cancel fixture')); await rejection;
  });
});

async function* from(input: ChatDelta[]) { yield* input; }
async function collect(input: ChatDelta[], maxEventBytes = limits.maxEventBytes) {
  const output: ChatDelta[] = [];
  for await (const delta of coalesceProviderDeltas(from(input), new AbortController().signal, { ...limits, maxEventBytes })) output.push(delta);
  return output;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(accept => { resolve = accept; });
  return { promise, resolve };
}
