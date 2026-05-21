/**
 * MessageBridge smoke tests — exercise req/res/evt round-trips over a
 * pair of in-memory fake ports without spinning up a real Worker.
 *
 * Why fake ports: the bridge contract is "anything with the
 * MessagePortLike shape works". Testing with a real `worker_threads`
 * Worker would also be valid but adds boot time and obscures whether
 * a failure is in the bridge itself or in the entry shim.
 */
import { describe, expect, it, vi } from 'vitest';
import { MessageBridge, type MessagePortLike } from '../MessageBridge.js';

/**
 * Pair of message ports that forward to each other in the same
 * process. Roughly mimics `MessageChannel` semantics but synchronous
 * enough for deterministic tests.
 */
function makePortPair(): [MessagePortLike, MessagePortLike] {
  const listeners: Record<'a' | 'b', Map<string, Set<(arg: unknown) => void>>> = {
    a: new Map(),
    b: new Map(),
  };
  function makePort(self: 'a' | 'b', peer: 'a' | 'b'): MessagePortLike {
    return {
      postMessage: (value: unknown) => {
        const peerListeners = listeners[peer].get('message');
        if (!peerListeners) return;
        // Defer to next microtask so callers can attach a `.then`
        // before the response fires.
        queueMicrotask(() => {
          for (const fn of peerListeners) fn(value);
        });
      },
      on: (event, listener) => {
        let set = listeners[self].get(event);
        if (!set) {
          set = new Set();
          listeners[self].set(event, set);
        }
        set.add(listener);
        return undefined;
      },
      off: (event, listener) => {
        listeners[self].get(event)?.delete(listener);
        return undefined;
      },
      close: () => {
        listeners[self].get('close')?.forEach((fn) => fn(undefined));
      },
    };
  }
  return [makePort('a', 'b'), makePort('b', 'a')];
}

describe('MessageBridge', () => {
  it('routes request → response with `ok: true`', async () => {
    const [a, b] = makePortPair();
    const left = new MessageBridge({ port: a });
    const right = new MessageBridge({ port: b });
    right.handle('echo', (payload) => ({ heard: payload }));
    const reply = await left.request<{ heard: { msg: string } }>('echo', { msg: 'hi' });
    expect(reply).toEqual({ heard: { msg: 'hi' } });
    left.dispose();
    right.dispose();
  });

  it('rejects when a handler throws — and surfaces the message', async () => {
    const [a, b] = makePortPair();
    const left = new MessageBridge({ port: a });
    const right = new MessageBridge({ port: b });
    right.handle('boom', () => {
      throw new Error('intentional');
    });
    await expect(left.request('boom', {})).rejects.toThrow('intentional');
    left.dispose();
    right.dispose();
  });

  it('rejects with `no_handler` when the peer has no matching handler', async () => {
    const [a, b] = makePortPair();
    const left = new MessageBridge({ port: a });
    const right = new MessageBridge({ port: b });
    let caughtCode: string | undefined;
    try {
      await left.request('does_not_exist', {});
    } catch (e) {
      caughtCode = (e as { code?: string }).code;
    }
    expect(caughtCode).toBe('no_handler');
    left.dispose();
    right.dispose();
  });

  it('delivers events to all subscribers with monotonic seq', async () => {
    const [a, b] = makePortPair();
    const left = new MessageBridge({ port: a });
    const right = new MessageBridge({ port: b });
    const received: Array<{ payload: unknown; seq?: number }> = [];
    left.on('ping', (payload, envelope) => {
      received.push({ payload, seq: envelope.seq });
    });
    right.emit('ping', { n: 1 });
    right.emit('ping', { n: 2 });
    right.emit('ping', { n: 3 });
    // Two microtask flushes: one for postMessage queueing, one for the
    // bridge to dispatch each event.
    await new Promise((r) => setTimeout(r, 0));
    expect(received).toEqual([
      { payload: { n: 1 }, seq: 1 },
      { payload: { n: 2 }, seq: 2 },
      { payload: { n: 3 }, seq: 3 },
    ]);
    left.dispose();
    right.dispose();
  });

  it('rejects in-flight requests on `dispose()`', async () => {
    const [a, b] = makePortPair();
    const left = new MessageBridge({ port: a });
    const right = new MessageBridge({ port: b });
    // Handler that never resolves so the request stays pending.
    right.handle('hang', () => new Promise(() => undefined));
    const pending = left.request('hang', {});
    left.dispose();
    await expect(pending).rejects.toThrow(/port closed/i);
    right.dispose();
  });

  it('honors request timeouts', async () => {
    const [a, b] = makePortPair();
    const left = new MessageBridge({ port: a });
    const right = new MessageBridge({ port: b });
    right.handle('slow', async () => new Promise((r) => setTimeout(r, 50)));
    await expect(left.request('slow', {}, { timeoutMs: 5 })).rejects.toThrow(/timed out/);
    left.dispose();
    right.dispose();
  });

  it('listener exceptions do not break the bridge', async () => {
    const [a, b] = makePortPair();
    const errors: unknown[] = [];
    const left = new MessageBridge({
      port: a,
      onListenerError: (err) => errors.push(err),
    });
    const right = new MessageBridge({ port: b });
    left.on('evt', () => {
      throw new Error('handler bug');
    });
    let goodReceived = 0;
    left.on('evt', () => {
      goodReceived += 1;
    });
    right.emit('evt', {});
    await new Promise((r) => setTimeout(r, 0));
    expect(goodReceived).toBe(1);
    expect(errors).toHaveLength(1);
    left.dispose();
    right.dispose();
  });
});
