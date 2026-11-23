import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReconnectingSSEClient } from '../ReconnectingSSEClient.js';

const enc = new TextEncoder();
const frame = (event: string) => enc.encode(`event: ${event}\ndata: {}\n\n`);
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('SSE terminal and silence lifecycle', () => {
  it.each(['done', 'error'])('delivers %s from slow command admission with one POST', async event => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(() => new Promise<Response>(resolve => {
      setTimeout(() => resolve(new Response(frame(event))), 155_000);
    }));
    vi.stubGlobal('fetch', fetchMock);
    const seen = vi.fn();
    const pending = new ReconnectingSSEClient({
      url: 'http://fixture/messages', method: 'POST', body: { client_msg_id: 'same-command' },
      signal: new AbortController().signal, idleTimeoutMs: 45_000, responseTimeoutMs: 180_000,
      onEvent: seen, isTerminal: ev => ev.event === event,
    }).run();
    await vi.advanceTimersByTimeAsync(155_001);
    await pending;
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(seen).toHaveBeenCalledWith(expect.objectContaining({ event }));
    expect(vi.getTimerCount()).toBe(0);
  });

  it('times out command admission even if fetch never settles', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})));
    const pending = new ReconnectingSSEClient({
      url: 'http://fixture/messages', method: 'POST', signal: new AbortController().signal,
      idleTimeoutMs: 45_000, responseTimeoutMs: 180_000, onEvent: vi.fn(),
      backoff: { nextDelay: () => null },
    }).run();
    const failed = expect(pending).rejects.toThrow('SSE response timed out');
    await vi.advanceTimersByTimeAsync(180_001);
    await failed;
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each(['done', 'error'])('finishes %s even if transport cancellation never settles', async event => {
    vi.useFakeTimers();
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(frame(event)); }, cancel,
    }))));
    const events: string[] = [];
    const completed = vi.fn();
    const pending = new ReconnectingSSEClient({ url: 'http://fixture/attach', method: 'GET',
      signal: new AbortController().signal, onEvent: ev => events.push(ev.event),
      isTerminal: ev => ev.event === event, idleTimeoutMs: 45_000,
    }).run().then(completed);
    await vi.advanceTimersByTimeAsync(1);
    expect(completed).toHaveBeenCalledOnce();
    expect(events).toEqual([event]);
    expect(cancel).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    await pending;
  });

  it('cancels a half-open custom stream without waiting for read/cancel', async () => {
    vi.useFakeTimers();
    const ctrl = new AbortController();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({ cancel: () => new Promise(() => {}) }))));
    const completed = vi.fn();
    const pending = new ReconnectingSSEClient({ url: 'http://fixture', method: 'GET',
      signal: ctrl.signal, onEvent: vi.fn(), idleTimeoutMs: 45_000 }).run().then(completed);
    await vi.advanceTimersByTimeAsync(1);
    ctrl.abort();
    await vi.advanceTimersByTimeAsync(1);
    expect(completed).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    await pending;
  });

  it('reconnects a silent socket with the same command and cursor', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(new ReadableStream({ cancel: () => new Promise(() => {}) })))
      .mockImplementationOnce(async () => new Response(frame('done')));
    vi.stubGlobal('fetch', fetchMock);
    const pending = new ReconnectingSSEClient({ url: 'http://fixture/messages', method: 'POST',
      body: { content: 'hi', client_msg_id: 'stable' }, signal: new AbortController().signal,
      getLastEventId: () => 12, getLastEventBusId: () => 'bus-a', onEvent: vi.fn(),
      idleTimeoutMs: 45_000, responseTimeoutMs: 180_000, backoff: { nextDelay: () => 0 },
    }).run();
    await vi.advanceTimersByTimeAsync(45_010);
    await pending;
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const first = fetchMock.mock.calls[0][1];
    const second = fetchMock.mock.calls[1][1];
    expect(second.body).toBe(first.body);
    expect(second.headers).toMatchObject({ 'Last-Event-ID': '12', 'X-MCP-Bus-ID': 'bus-a' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps a long-thinking agent alive while transport heartbeats arrive', async () => {
    vi.useFakeTimers();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const fetchMock = vi.fn(async () => new Response(new ReadableStream({ start(c) { controller = c; } })));
    vi.stubGlobal('fetch', fetchMock);
    const done = vi.fn();
    const pending = new ReconnectingSSEClient({ url: 'http://fixture', method: 'GET',
      signal: new AbortController().signal, onEvent: vi.fn(), idleTimeoutMs: 45_000,
    }).run().then(done);
    await vi.advanceTimersByTimeAsync(1);
    for (let i = 0; i < 24; i++) { controller.enqueue(frame('ping')); await vi.advanceTimersByTimeAsync(15_000); }
    expect(done).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledOnce();
    controller.enqueue(frame('done'));
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(vi.getTimerCount()).toBe(0);
  });
});
