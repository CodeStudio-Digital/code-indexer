import { describe, expect, it, vi } from 'vitest';
import type { Hono } from 'hono';
import { dispatchStreaming } from '../hono-dispatch.js';

const sessionId = '10000000-0000-4000-8000-000000000001';

describe('Hono SSE observation lifetime', () => {
  it('cancels an idle pending reader immediately when its subscriber aborts', async () => {
    const cancel = vi.fn();
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const body = new ReadableStream<Uint8Array>({ pull() { started(); }, cancel });
    const app = { fetch: async () => new Response(body) } as unknown as Hono;
    const controller = new AbortController();
    const iterator = dispatchStreaming(app, 'coder.stream.attach', { sessionId }, controller.signal);
    const pending = iterator.next();
    await ready; await Promise.resolve();
    controller.abort(new Error('subscriber closed'));
    expect(await pending).toEqual({ value: undefined, done: true });
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
  });

  it('cancels an unfinished response when the consumer returns between frames', async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode('data: {"value":1}\n\n')); }, cancel,
    });
    const app = { fetch: async () => new Response(body) } as unknown as Hono;
    const iterator = dispatchStreaming(app, 'coder.stream.attach', { sessionId });
    expect((await iterator.next()).done).toBe(false);
    await iterator.return();
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
  });
});
