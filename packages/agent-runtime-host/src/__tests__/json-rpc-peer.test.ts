import { describe, expect, it } from 'vitest';
import {
  BoundedJsonRpcPeer,
  type EngineJsonRpcTransport,
} from '../engine-bakeoff/JsonRpcPeer.js';

class QueueTransport implements EngineJsonRpcTransport {
  readonly sent: Readonly<Record<string, unknown>>[] = [];
  readonly #values: unknown[] = [];
  readonly #waiters: Array<(value: IteratorResult<unknown>) => void> = [];
  #closed = false;

  async send(message: Readonly<Record<string, unknown>>): Promise<void> {
    this.sent.push(message);
  }

  messages(): AsyncIterable<unknown> {
    return { [Symbol.asyncIterator]: () => ({ next: () => this.#next() }) };
  }

  async close(): Promise<void> {
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) waiter({ done: true, value: undefined });
  }

  push(value: unknown): void {
    const waiter = this.#waiters.shift();
    if (waiter) waiter({ done: false, value });
    else this.#values.push(value);
  }

  get closed(): boolean {
    return this.#closed;
  }

  #next(): Promise<IteratorResult<unknown>> {
    if (this.#values.length > 0) {
      return Promise.resolve({ done: false, value: this.#values.shift() });
    }
    if (this.#closed) return Promise.resolve({ done: true, value: undefined });
    return new Promise((resolve) => this.#waiters.push(resolve));
  }
}

describe('BoundedJsonRpcPeer', () => {
  it('correlates responses and answers server requests without blocking notifications', async () => {
    const transport = new QueueTransport();
    const notifications: string[] = [];
    const peer = new BoundedJsonRpcPeer(transport);
    peer.start({
      onNotification: (method) => { notifications.push(method); },
      onRequest: async (method, params) => ({ method, params }),
    }, new AbortController().signal);

    const response = peer.request('initialize', { client: 'test' });
    await eventually(() => transport.sent.length === 1);
    transport.push({ id: 1, result: { ok: true } });
    await expect(response).resolves.toEqual({ ok: true });

    transport.push({ method: 'turn/started', params: { turnId: 'turn-1' } });
    transport.push({ method: 'item/tool/call', id: 90, params: { callId: 'call-1' } });
    await eventually(() => transport.sent.length === 2);

    expect(notifications).toEqual(['turn/started']);
    expect(transport.sent[1]).toEqual({
      id: 90,
      result: { method: 'item/tool/call', params: { callId: 'call-1' } },
    });
    await peer.close();
  });

  it('fails closed when an inbound message exceeds its byte budget', async () => {
    const transport = new QueueTransport();
    let closedError: Error | undefined;
    const peer = new BoundedJsonRpcPeer(transport, { maxInboundBytes: 32 });
    peer.start({
      onNotification: () => undefined,
      onRequest: async () => ({}),
      onClosed: (error) => { closedError = error; },
    }, new AbortController().signal);

    const pending = peer.request('test', {});
    transport.push({ id: 1, result: { text: 'x'.repeat(128) } });

    await expect(pending).rejects.toMatchObject({ code: 'inbound_message_limit' });
    expect(closedError).toMatchObject({ code: 'inbound_message_limit' });
    await peer.close();
    expect(transport.closed).toBe(true);
  });
});

async function eventually(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error('Condition was not met');
}
