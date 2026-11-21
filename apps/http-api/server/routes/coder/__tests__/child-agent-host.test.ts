/**
 * The app's child-agent host with a fake worker pool and command admission
 * over real stores (app and worker instances): create starts what the tree
 * admits with its task, the end of a run starts the next, an approval prompt
 * is reported to the waiting parent, and a start accepted before a restart
 * that is not live is released instead of running twice.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { childFixture, hostHarness, type ChildHostFixture } from './child-agent-host-fixture.js';
import { addBusEventSink, createBus } from '../../../../coder-bus.js';
import { recentNotificationRuntimeEvents } from '../../../../sse/notification-event-bus.js';
import { createChildChatPort } from '../child-chat-caller.js';
import { createChildChatBridgeClient } from '@mcp/code-agent/ports/child-chat-bridge-client.js';
import { installChildChatBridge } from '../../../../sse/child-chat-bridge.js';

vi.mock('../../../../sse/coderWorkerPoolSingleton.js', () => ({ getCoderWorkerPool: () => { throw new Error('the test passes its own pool'); } }));
vi.mock('../../../../control-plane-shadow.js', () => ({
  acceptLocalCoderCommand: vi.fn(), bindLocalCommandBus: vi.fn(), terminalizeLocalCoderCommand: vi.fn(),
}));
vi.mock('../../../../custom-agents.js', () => ({ resolveAgentSelection: vi.fn() }));

const { createChildAgentHost } = await import('../child-agent-host.js');

let f: ChildHostFixture;
const h = hostHarness(createChildAgentHost, () => f);
const settle = () => new Promise((done) => setTimeout(done, 100));

beforeEach(async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined); // no provider DB in this fixture
  f = await childFixture('child-agent-host-');
  h.reset();
});
afterEach(async () => { vi.restoreAllMocks(); await f.close(); });

describe('child-agent host', () => {
  it.each([false, true])('publishes a listable child before worker startup and honors wait=%s across the bridge', async (wait) => {
    const host = h.makeHost();
    const port = createChildChatPort(host, { sessions: f.app, mailbox: f.mailbox });
    const handlers = new Map<string, (payload: unknown) => unknown>();
    const off = installChildChatBridge({ handle: (key, fn) => { handlers.set(key, fn); return () => handlers.delete(key); } }, f.rootId, () => port);
    const client = createChildChatBridgeClient({ request: async <T>(key: string, payload: unknown) => await handlers.get(key)!(payload) as T });
    const parentBus = createBus(new AbortController());
    h.buses.set(f.rootId, parentBus);
    let start!: () => void;
    h.gate = new Promise(resolve => { start = resolve; });
    const announced = new Promise<string>(resolve => addBusEventSink(parentBus, event => {
      if (event.event === 'chat_session_created') resolve((event.data as { sessionId: string }).sessionId);
    }));
    const request = { key: 'call', title: 'Reviewer', profile: 'review', task: 'Review.', wait };
    const pending = client.create(f.rootId, request);
    try {
      const childId = await Promise.race([announced, pending.then(() => announced)]);
      const announcements = () => parentBus.buffer.filter(event => event.event === 'chat_session_created');
      expect(announcements().map(event => event.data)).toEqual([
        { sessionId: childId, ...(wait ? { waitingToolUseId: 'call', title: 'Reviewer' } : {}) },
      ]);
      expect((await f.app.listSessions(1)).map(session => session.id)).toContain(childId);
      if (!wait) expect((await pending).chatId).toBe(childId); // Worker startup is still gated.
      start();
      await pending;
      await vi.waitFor(() => expect(h.buses.has(childId)).toBe(true), { timeout: 5_000 });
      expect(await f.queue.get(childId)).toMatchObject({ state: 'admitted', background: !wait });
      await client.create(f.rootId, request);
      expect(announcements()).toHaveLength(1);
      expect(h.runFresh).toHaveBeenCalledTimes(1);
      await f.holdLease(childId);
      await f.conclude(childId, 'All done.');
      h.endRun(childId);
      expect((await client.wait(f.rootId, { chatIds: [childId], timeoutMs: 2_000 })).items[0]).toMatchObject({ status: 'completed', finalText: 'All done.' });
      await vi.waitFor(async () => expect((await f.queue.get(childId)).state).toBe('released'), { timeout: 5_000 });
      if (!wait) await vi.waitFor(async () => expect((await f.queue.get(childId)).notified_release_at).toBeTruthy(), { timeout: 5_000 });
    } finally { start(); off(); await pending.catch(() => {}); }
  }, 15_000);

  it('announces a new child to all views when the parent has no live bus', async () => {
    const host = h.makeHost();
    const { child } = await host.create(f.rootId, { key: 'k', title: 'Queued reviewer', profile: 'review', task: 'Review', start: false });
    expect(recentNotificationRuntimeEvents(0)).toContainEqual(expect.objectContaining({
      event: 'chat_session_created', sessionId: f.rootId, data: { sessionId: child.id },
    }));
  });

  it('starts what the tree admits with its task and the next one when a run ends', async () => {
    const host = h.makeHost();
    const ids: string[] = [];
    for (const key of ['a', 'b', 'c', 'd']) {
      const { child } = await host.create(f.rootId, { key, title: key, profile: 'explore', task: `do ${key}`, start: false });
      await f.holdLease(child.id); // the child's worker owns its bundle from here on
      ids.push(child.id);
    }
    for (const id of ids) await host.service.request(id, `do ${id}`);
    expect(h.runFresh.mock.calls.map(([id, options]) => [id, options.userMessage])).toEqual(ids.slice(0, 3).map((id) => [id, `do ${id}`]));
    await f.conclude(ids[0]!, 'A done.');
    h.endRun(ids[0]!);
    await settle();
    expect(h.runFresh.mock.calls.map(([id]) => id)).toEqual(ids);
    expect((await host.wait({ chatIds: [ids[0]!], timeoutMs: 2_000, pollMs: 20 })).items[0]).toMatchObject({ status: 'completed', finalText: 'A done.' });
  });

  it('reports a pending approval to the waiting parent', async () => {
    const host = h.makeHost();
    const { child } = await host.create(f.rootId, { key: 'a', title: 'a', profile: 'explore', task: 'do a' });
    h.emit(child.id, 'tool_approval_request');
    expect(host.awaitingApproval(child.id)).toBe(true);
    expect((await host.wait({ chatIds: [child.id], timeoutMs: 2_000, pollMs: 20 })).items[0]!.status).toBe('awaiting_approval');
    h.emit(child.id, 'tool_approval_resolved');
    expect(host.awaitingApproval(child.id)).toBe(false);
  });

  it('after a restart, releases a start that was accepted but is not live instead of running it again', async () => {
    const first = h.makeHost();
    const { child } = await first.create(f.rootId, { key: 'a', title: 'a', profile: 'explore', task: 'do a' });
    expect(h.runFresh).toHaveBeenCalledTimes(1);
    await f.restart();
    h.buses = new Map(); // the app restarted: no live run
    const restarted = h.makeHost();
    await restarted.service.resume();
    expect(h.runFresh).not.toHaveBeenCalled();
    expect(await f.queue.get(child.id)).toMatchObject({ state: 'released', release_reason: 'start_unknown' });
    expect((await restarted.wait({ chatIds: [child.id], timeoutMs: 500, pollMs: 20 })).items[0]).toMatchObject({ status: 'failed', reason: 'start_unknown' });
  });
});
