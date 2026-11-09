import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRendererStream } from '../renderer-stream.js';
import { pumpMessagePortStream } from '../stream-lifecycle.js';

function rendererFixture() {
  let accept!: (port: MessagePort) => void;
  const disconnect = vi.fn();
  const cancel = vi.fn();
  const port = { onmessage: null, onmessageerror: null, start: vi.fn(), close: vi.fn() } as unknown as MessagePort;
  const stream = createRendererStream<string>(callback => { accept = callback; return disconnect; }, cancel);
  const frame = (data: unknown) => port.onmessage?.({ data } as MessageEvent);
  return { stream, port, frame, disconnect, cancel, transfer: () => accept(port) };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('renderer stream lifetime', () => {
  it('settles pending reads, drops buffered and late frames, and closes exactly once', async () => {
    const f = rendererFixture(); f.transfer();
    const first = f.stream.next(), second = f.stream.next();
    const lateHandler = f.port.onmessage!;
    await f.stream.return!(); await f.stream.return!();
    expect(await first).toEqual({ done: true });
    expect(await second).toEqual({ done: true });
    lateHandler.call(f.port, { data: { type: 'value', value: 'late' } } as MessageEvent);
    expect(await f.stream.next()).toEqual({ done: true });
    expect(f.port.close).toHaveBeenCalledOnce();
    expect(f.port.onmessage).toBeNull();
    expect(f.disconnect).toHaveBeenCalledOnce();
    expect(f.cancel).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('closes a port transferred after return and releases the transfer listener', async () => {
    const f = rendererFixture();
    const pending = f.stream.next();
    await f.stream.return!();
    expect(await pending).toEqual({ done: true });
    expect(f.cancel).toHaveBeenCalledOnce();
    f.transfer();
    expect(f.port.close).toHaveBeenCalledOnce();
    expect(f.port.start).not.toHaveBeenCalled();
    expect(f.disconnect).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('bounds a missing transfer and releases its listener even after early return', async () => {
    const missing = rendererFixture();
    const pending = expect(missing.stream.next()).rejects.toThrow('transfer timed out');
    await vi.advanceTimersByTimeAsync(15_000); await pending;
    expect(missing.disconnect).toHaveBeenCalledOnce();
    expect(missing.cancel).toHaveBeenCalledOnce();
    const cancelled = rendererFixture();
    await cancelled.stream.return!();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(cancelled.disconnect).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('preserves normal buffered delivery but discards the buffer on explicit return', async () => {
    const f = rendererFixture(); f.transfer();
    f.frame({ type: 'value', value: 'one' }); f.frame({ type: 'value', value: 'two' });
    f.frame({ type: 'done' });
    expect(await f.stream.next()).toEqual({ value: 'one', done: false });
    await f.stream.return!();
    expect(await f.stream.next()).toEqual({ done: true });
    expect(f.port.close).toHaveBeenCalledOnce();
  });

  it('rejects a pending read with the original error metadata', async () => {
    const f = rendererFixture(); f.transfer();
    const pending = expect(f.stream.next()).rejects.toMatchObject({ message: 'offline', code: 'unavailable', status: 503 });
    f.frame({ type: 'error', error: { message: 'offline', code: 'unavailable', status: 503 } });
    await pending;
    expect(f.port.close).toHaveBeenCalledOnce();
  });
});

class MainPort extends EventEmitter {
  start = vi.fn();
  close = vi.fn(() => this.emit('close'));
  postMessage = vi.fn();
}

describe('main stream lifetime', () => {
  it('ends a pending subscription on peer close', async () => {
    const main = new MainPort();
    const renderer = rendererFixture();
    vi.mocked(renderer.port.close).mockImplementation(() => { main.emit('close'); });
    renderer.transfer();
    const controller = new AbortController();
    let subscribers = 1;
    const iterator: AsyncIterableIterator<string> = {
      [Symbol.asyncIterator]() { return this; },
      next: () => new Promise(() => {}),
      return: vi.fn(async () => { subscribers--; return { value: undefined, done: true as const }; }),
    };
    const pumping = pumpMessagePortStream(main as unknown as Electron.MessagePortMain, () => iterator, controller, String);
    await renderer.stream.return!();
    await pumping;
    expect(subscribers).toBe(0);
    expect(iterator.return).toHaveBeenCalledOnce();
    expect(controller.signal.aborted).toBe(true);
    expect(main.listenerCount('close')).toBe(0);
    expect(main.postMessage).not.toHaveBeenCalled();
  });

  it('finishes a normal stream without treating completion as cancellation', async () => {
    const port = new MainPort(), controller = new AbortController();
    await pumpMessagePortStream(port as unknown as Electron.MessagePortMain, async function* () { yield 'value'; }, controller, String);
    expect(port.postMessage.mock.calls).toEqual([[{ type: 'value', value: 'value' }], [{ type: 'done' }]]);
    expect(controller.signal.aborted).toBe(false);
    expect(port.listenerCount('close')).toBe(0);
    expect(port.close).toHaveBeenCalledOnce();
  });

  it('releases a stream after renderer lifetime cancellation', async () => {
    const port = new MainPort(), controller = new AbortController();
    const iterator: AsyncIterableIterator<unknown> = {
      [Symbol.asyncIterator]() { return this; },
      next: () => new Promise(() => {}),
      return: vi.fn(async () => ({ value: undefined, done: true })),
    };
    const pumping = pumpMessagePortStream(port as unknown as Electron.MessagePortMain, () => iterator, controller, String);
    controller.abort(new Error('renderer gone'));
    await pumping;
    expect(iterator.return).toHaveBeenCalledOnce();
    expect(port.close).toHaveBeenCalledOnce();
    expect(port.listenerCount('close')).toBe(0);
  });
});
