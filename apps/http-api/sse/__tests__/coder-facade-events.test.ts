import { describe, expect, it } from 'vitest';
import type { ControlPlaneRunContext } from '@mcp/store/control-plane/index.js';
import { BUFFER_CAP, createBus, markEnded, publish } from '../../coder-bus.js';
import { subscribeCoderFacadeEvents } from '../coder-facade-events.js';

const context = { sessionId: 'session', commandId: 'command', agentRunId: 'run', attemptId: 'attempt',
  correlationId: 'correlation', actor: { actorId: 'user', actorType: 'user', source: 'http' } } as ControlPlaneRunContext;

describe('facade volatile event compatibility', () => {
  it('wakes for individual results and does not wait for a batch or terminal', async () => {
    const bus = createBus(new AbortController());
    const events = subscribeCoderFacadeEvents(bus, context)[Symbol.asyncIterator]();
    const pending = events.next();
    expect(bus.subscribers.size).toBe(1);
    publish(bus, 'tool_result', { toolUseId: 'fast' });
    expect((await pending).value).toMatchObject({ type: 'legacy.tool_result', globalSeq: 0 });
    expect(bus.subscribers.size).toBe(0);
    const waiting = events.next();
    await events.return?.();
    expect(await waiting).toMatchObject({ done: true });
    expect(bus.subscribers.size).toBe(0);
    expect(bus.endListeners.size).toBe(0);
  });

  it('requires the originating stream and refuses reconnect or slow-consumer gaps', async () => {
    const bus = createBus(new AbortController());
    publish(bus, 'delta', { text: 'one' });
    const consumer = subscribeCoderFacadeEvents(bus, context)[Symbol.asyncIterator]();
    await consumer.next();
    for (let i = 0; i <= BUFFER_CAP; i++) publish(bus, 'delta', { i });
    await expect(consumer.next()).rejects.toThrow('expired');
    await expect(subscribeCoderFacadeEvents(bus, context, { afterGlobalSeq: 0, streamId: bus.busId })
      [Symbol.asyncIterator]().next()).rejects.toThrow('expired');
    await expect(subscribeCoderFacadeEvents(bus, context, { afterGlobalSeq: bus.nextSeq - 1, streamId: 'old-bus' })
      [Symbol.asyncIterator]().next()).rejects.toThrow('another stream');
    const resumed = subscribeCoderFacadeEvents(bus, context, { afterGlobalSeq: bus.nextSeq - 1, streamId: bus.busId })
      [Symbol.asyncIterator]();
    const pending = resumed.next();
    markEnded(bus, 'done', { reason: 'completed' });
    expect((await pending).value).toMatchObject({ type: 'legacy.done', globalSeq: bus.nextSeq });
    expect(await resumed.next()).toMatchObject({ done: true });
  });
});
