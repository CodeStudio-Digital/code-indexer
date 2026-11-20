/**
 * The app's child-agent host with a fake worker pool and command admission
 * over real stores (app and worker instances): create starts what the tree
 * admits with its task, the end of a run starts the next, an approval prompt
 * is reported to the waiting parent, and a start accepted before a restart
 * that is not live is released instead of running twice.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { childFixture, hostHarness, type ChildHostFixture } from './child-agent-host-fixture.js';

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
