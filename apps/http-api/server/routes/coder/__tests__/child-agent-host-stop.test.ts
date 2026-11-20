/**
 * Stopping through the app's child-agent host, with a fake worker pool over
 * real stores: an ancestor's stop aborts the live run in the pool and its
 * slot starts the next child; the user's Stop on a root (the cascade the
 * session routes call) stops the whole tree and starts nothing; a stop that
 * lands while a start is in progress still ends that run; and after a stop
 * only the parent's explicit new start runs the child again, never a message.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rootChatId } from '@mcp/session-storage/collaboration/store.js';
import { childFixture, hostHarness, type ChildHostFixture } from './child-agent-host-fixture.js';

vi.mock('../../../../sse/coderWorkerPoolSingleton.js', () => ({ getCoderWorkerPool: () => { throw new Error('the test passes its own pool'); } }));
vi.mock('../../../../control-plane-shadow.js', () => ({
  acceptLocalCoderCommand: vi.fn(), bindLocalCommandBus: vi.fn(), terminalizeLocalCoderCommand: vi.fn(),
}));
vi.mock('../../../../custom-agents.js', () => ({ resolveAgentSelection: vi.fn() }));

const { createChildAgentHost } = await import('../child-agent-host.js');
const { childAgentAttention } = await import('../child-agent-attention.js');
const { setChildAgentCascade, stopChildAgentsOf } = await import('../child-agent-cascade.js');

let f: ChildHostFixture;
const h = hostHarness(createChildAgentHost, () => f);
let published: Array<{ sessionId: string; event: string; data: any }>;
const settle = () => new Promise((done) => setTimeout(done, 100));
const makeHost = () => h.makeHost({ attention: childAgentAttention((event) => { published.push(event as never); return null; }) });
const stopsPublished = () => published.filter((event) => event.event === 'child_agents_stopped').map(({ sessionId, data }) => [sessionId, data.count, data.reason]);

async function children(host: ReturnType<typeof makeHost>, keys: string[]) {
  const ids: string[] = [];
  for (const key of keys) ids.push((await host.create(f.rootId, { key, title: key, profile: 'explore', task: `do ${key}` })).child.id);
  return ids;
}

beforeEach(async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined); // no provider DB in this fixture
  f = await childFixture('child-agent-host-stop-');
  h.reset();
  published = [];
});
afterEach(async () => { setChildAgentCascade(null); vi.restoreAllMocks(); await f.close(); });

describe('child-agent host: stopping', () => {
  it("an ancestor's stop aborts the live run and its slot starts the next child", async () => {
    const host = makeHost();
    const [a, b, , d] = await children(host, ['a', 'b', 'c', 'd']);
    expect(h.runFresh).toHaveBeenCalledTimes(3);
    await expect(host.stop(b!, [a!])).rejects.toMatchObject({ code: 'not_an_ancestor' });
    expect(h.abort).not.toHaveBeenCalled();
    expect(await host.stop(f.rootId, [a!])).toEqual({ stopped: [a] });
    expect(h.abort.mock.calls.map(([id]) => id)).toEqual([a]);
    await settle();
    expect(h.runFresh.mock.calls.map(([id]) => id).at(-1)).toBe(d);
    expect(await f.queue.get(a!)).toMatchObject({ state: 'released', stop_reason: 'stopped_by_parent' });
    expect(stopsPublished()).toEqual([[f.rootId, 1, 'stopped_by_parent']]);
  });

  it("the user's Stop on the root, through the session routes' cascade, stops the tree and starts nothing", async () => {
    const host = makeHost();
    setChildAgentCascade((id, reason) => host.stopSession(id, reason));
    const ids = await children(host, ['a', 'b', 'c', 'd', 'e']);
    const covered = await stopChildAgentsOf(f.rootId, 'stopped_by_user');
    expect([...covered].sort()).toEqual([...ids].sort());
    await settle();
    expect(h.abort.mock.calls.map(([id]) => id).sort()).toEqual(ids.slice(0, 3).sort());
    expect(h.runFresh).toHaveBeenCalledTimes(3);
    for (const id of ids.slice(3)) expect(await f.queue.get(id)).toMatchObject({ state: 'released', release_reason: 'stopped' });
    expect(stopsPublished()).toEqual([[f.rootId, 5, 'stopped_by_user']]);
    setChildAgentCascade(async () => { throw new Error('host down'); });
    expect(await stopChildAgentsOf(f.rootId, 'stopped_by_user')).toEqual([]); // the route's own Stop still goes on
    setChildAgentCascade(null);
    expect(await stopChildAgentsOf(f.rootId, 'stopped_by_user')).toEqual([]);
  });

  it('ends a run whose start was in progress when the stop landed', async () => {
    const host = makeHost();
    let open!: () => void;
    h.gate = new Promise((resolve) => { open = resolve; });
    const creating = host.create(f.rootId, { key: 'a', title: 'a', profile: 'explore', task: 'do a' });
    await expect.poll(() => h.runFresh.mock.calls.length).toBe(1); // the start holds the child's lock
    const a = (await f.queue.list())[0]!.child_id;
    const stopping = host.stop(f.rootId, [a]);
    await settle();
    expect(h.abort).not.toHaveBeenCalled(); // the abort waits for the start
    open();
    await Promise.all([creating, stopping]);
    await settle();
    expect(h.abort.mock.calls.map(([id]) => id)).toEqual([a]);
    expect(h.buses.get(a)!.ended).toBe(true);
    expect(await f.queue.get(a)).toMatchObject({ state: 'released' });
  });

  it('runs a stopped child again only on its parent\'s explicit new start, never on a message', async () => {
    const host = makeHost();
    const [a] = await children(host, ['a']);
    await f.holdLease(a!);
    const pending = await f.mailbox.send({ from: rootChatId(f.rootId), to: rootChatId(a!), kind: 'task', body: 'More.', idempotencyKey: 'm1' });
    await host.stop(f.rootId, [a!]);
    await settle();
    expect((await f.mailbox.get(pending.id)).status).toBe('cancelled'); // the stop withdrew it
    expect(await host.wake(pending)).toBe(false);
    expect(h.runFresh).toHaveBeenCalledTimes(1);
    await host.create(f.rootId, { key: 'a', title: 'a', profile: 'explore', task: 'start over' });
    expect(h.runFresh).toHaveBeenCalledTimes(2);
    expect(h.runFresh.mock.calls[1]).toMatchObject([a, { userMessage: 'start over' }]);
    expect(await f.queue.get(a!)).toMatchObject({ state: 'admitted', stop_requested_at: null });
  });
});
