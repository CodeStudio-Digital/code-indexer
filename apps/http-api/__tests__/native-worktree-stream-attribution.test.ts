import { expect, it } from 'vitest';
import type { ControlPlaneRunContext } from '@mcp/store/control-plane/index.js';
import { createBus, markEnded, publish } from '../coder-bus.js';
import { bindNativeCoderFacadeContext, subscribeCoderFacadeEvents } from '../sse/coder-facade-events.js';

const context = (attempt: string) => ({ sessionId: 'session', agentRunId: `run-${attempt}`, commandId: `command-${attempt}`,
  attemptId: attempt, correlationId: `correlation-${attempt}`, actor: { type: 'user', id: 'fixture' } }) as unknown as ControlPlaneRunContext;

it('attributes both an existing stream and reconnect replay to their original workspace attempts', async () => {
  const bus = createBus(new AbortController()); const first = context('first'); const second = context('second');
  bindNativeCoderFacadeContext(bus, first);
  const live = subscribeCoderFacadeEvents(bus, first, undefined, 'native')[Symbol.asyncIterator]();
  publish(bus, 'tool_call_result', { id: 'enter' });
  expect((await live.next()).value?.attemptId).toBe('first');
  bindNativeCoderFacadeContext(bus, second);
  publish(bus, 'tool_call_start', { id: 'inside' });
  expect((await live.next()).value?.attemptId).toBe('second');
  markEnded(bus, 'done', {});
  expect((await live.next()).value?.attemptId).toBe('second');
  expect((await live.next()).done).toBe(true);
  const replay = [];
  for await (const event of subscribeCoderFacadeEvents(bus, second, undefined, 'native')) replay.push(event.attemptId);
  expect(replay).toEqual(['first', 'second', 'second']);
  expect(() => bindNativeCoderFacadeContext(bus, { ...second, sessionId: 'foreign' } as ControlPlaneRunContext)).toThrow('change sessions');
});
