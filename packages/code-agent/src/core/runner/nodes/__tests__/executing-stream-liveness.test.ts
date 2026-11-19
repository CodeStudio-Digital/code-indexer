import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatDelta } from '@mcp/provider-sdk';
import { consumeStream } from '../executing-stream.js';
import { ExecutingNode } from '../executing.js';
import { makeTestContext } from './test-helpers.js';
import { ToolRegistry } from '../../../registry.js';
import type { ToolContext } from '../../../tool.js';

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
beforeEach(() => vi.useFakeTimers({ toFake: ['Date', 'performance', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] }));
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

describe('provider stream liveness', () => {
  it('measures latency for any adapter without inventing HTTP headers or dropping provider metadata', async () => {
    async function* stream(): AsyncIterable<ChatDelta> {
      yield { type: 'response_meta', meta: { path: '/vendor/stream', response: { request_id: 'request-fixture' } } };
      await sleep(20);
      yield { type: 'text_delta', text: 'done' };
      await sleep(30);
      yield { type: 'done' };
    }
    const pending = consumeStream({ stream: stream() });
    await vi.advanceTimersByTimeAsync(50);
    const result = await pending;
    expect(result.responseMeta).toMatchObject({ path: '/vendor/stream', response: { request_id: 'request-fixture' },
      timing: { transport: 'stream', headers_ms: null, first_event_ms: 0, first_content_ms: 20, total_ms: 50 } });
  });

  it('allows 35 minutes of active thinking, then commits the answer without retries', async () => {
    vi.stubEnv('CODER_STREAM_THINKING_ONLY_TIMEOUT_MS', '1'); // retired setting cannot resurrect the cutoff
    const cancelStream = vi.fn();
    async function* stream(): AsyncIterable<ChatDelta> {
      for (let n = 0; n < 35; n++) {
        await sleep(60_000);
        yield { type: 'thinking_delta', text: `step ${n};` };
      }
      yield { type: 'text_delta', text: 'Completed after sustained reasoning.' };
      yield { type: 'done', stop_reason: 'end_turn' };
    }
    const result = consumeStream({ stream: stream(), cancelStream });
    const verified = expect(result).resolves.toMatchObject({ textBlocks: ['Completed after sustained reasoning.'], stopReason: 'end_turn' });
    await vi.advanceTimersByTimeAsync(35 * 60_000);
    await verified;
    expect(cancelStream).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([undefined, 'high', 'max'])('does not reintroduce a wall-clock cutoff in Executing at effort %s', async reasoningEffort => {
    let calls = 0;
    const { ctx, recordedEvents } = makeTestContext({ provider: {
      name: 'mock', model: 'claude-opus-4-6', setModel() {},
      async *chat(): AsyncIterable<ChatDelta> {
        calls++;
        for (let n = 0; n < 12; n++) { await sleep(60_000); yield { type: 'thinking_delta', text: 'Analyzing. ' }; }
        yield { type: 'text_delta', text: 'Done.' };
        yield { type: 'done', stop_reason: 'end_turn' };
      },
    }, registry: new ToolRegistry(), toolContext: { cwd: process.cwd(), projectName: 'test' } as ToolContext });
    ctx.opts.reasoningEffort = reasoningEffort;
    const pending = new ExecutingNode().execute(ctx, null);
    const verified = expect(pending).resolves.toMatchObject({ kind: 'CleanFinish' });
    await vi.advanceTimersByTimeAsync(12 * 60_000);
    await verified;
    expect(calls).toBe(1);
    expect(recordedEvents.some(event => event.event === 'stream_rollback')).toBe(false);
    expect(ctx.recovery.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('accepts real transport keepalives while an SDK emits no visible deltas', async () => {
    let activity: number | undefined;
    async function* stream(): AsyncIterable<ChatDelta> {
      yield { type: 'thinking_delta', text: 'Working' };
      for (let n = 0; n < 15; n++) { await sleep(60_000); activity = performance.now(); }
      yield { type: 'text_delta', text: 'Complete' };
      yield { type: 'done' };
    }
    const verified = expect(consumeStream({ stream: stream(), lastTransportActivityAt: () => activity }))
      .resolves.toMatchObject({ textBlocks: ['Complete'] });
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    await verified;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('times out actual silence after the last keepalive, without tuning a retired env flag', async () => {
    let activity: number | undefined;
    const cancelStream = vi.fn();
    async function* stream(): AsyncIterable<ChatDelta> {
      yield { type: 'thinking_delta', text: 'Working' };
      await sleep(60_000); activity = performance.now();
      await new Promise(() => {});
    }
    const verified = expect(consumeStream({ stream: stream(), cancelStream, lastTransportActivityAt: () => activity }))
      .rejects.toMatchObject({ code: 'TIMEOUT', message: expect.stringContaining('90000ms without received activity') });
    await vi.advanceTimersByTimeAsync(149_999);
    expect(cancelStream).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await verified;
    expect(cancelStream).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not let another active session keep a silent request alive', async () => {
    let activity: number | undefined;
    const silent = { [Symbol.asyncIterator]: () => ({ next: () => new Promise<IteratorResult<ChatDelta>>(() => {}) }) };
    const verifiedSilent = expect(consumeStream({ stream: silent, firstByteTimeoutMs: 240_000 })).rejects.toMatchObject({ code: 'TIMEOUT' });
    async function* active(): AsyncIterable<ChatDelta> {
      for (let n = 0; n < 8; n++) { await sleep(60_000); activity = performance.now(); }
      yield { type: 'text_delta', text: 'Other session completed' }; yield { type: 'done' };
    }
    const verifiedActive = expect(consumeStream({ stream: active(), lastTransportActivityAt: () => activity })).resolves.toMatchObject({ textBlocks: ['Other session completed'] });
    await vi.advanceTimersByTimeAsync(480_000);
    await Promise.all([verifiedSilent, verifiedActive]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('still honours an immediate user stop during long reasoning', async () => {
    const controller = new AbortController(), cancelStream = vi.fn();
    const stream = { [Symbol.asyncIterator]: () => ({ next: () => new Promise<IteratorResult<ChatDelta>>(() => {}) }) };
    const verified = expect(consumeStream({ stream, signal: controller.signal, cancelStream })).rejects.toMatchObject({ code: 'ABORTED' });
    controller.abort();
    await verified;
    expect(cancelStream).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
