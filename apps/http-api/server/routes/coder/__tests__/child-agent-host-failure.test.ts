/**
 * The host's launcher when a child fails: a start whose runFresh throws and a
 * run that ends with an error are both written to the app log with their
 * message, and the parent's wait reports the same reason.
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
let warn: ReturnType<typeof vi.spyOn>;
const h = hostHarness(createChildAgentHost, () => f);
const warned = () => warn.mock.calls.map((call: unknown[]) => call.map(String).join(' '));

beforeEach(async () => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  f = await childFixture('child-agent-host-failure-');
  h.reset();
});
afterEach(async () => { vi.restoreAllMocks(); await f.close(); });

describe('child-agent host: failure reasons', () => {
  it('logs a start that failed and reports its message to the waiting parent', async () => {
    const host = h.makeHost();
    h.runFresh.mockRejectedValueOnce(new Error('worker spawn refused'));
    const { child } = await host.create(f.rootId, { key: 'a', title: 'a', profile: 'explore', task: 'do a' });
    expect(warned()).toContain(`[child-agent] start of ${child.id} failed: start_failed: worker spawn refused`);
    expect((await host.wait({ chatIds: [child.id], timeoutMs: 0 })).items[0]).toMatchObject({
      status: 'failed', reason: 'start_failed: worker spawn refused' });
  });

  it('logs a run that ended with an error and reports its message to the waiting parent', async () => {
    const host = h.makeHost();
    const { child } = await host.create(f.rootId, { key: 'a', title: 'a', profile: 'explore', task: 'do a' });
    const bus = h.buses.get(child.id)!;
    bus.ended = true;
    bus.endReason = { event: 'error', data: { reason: 'error', message: `Session ${child.id} not found` } };
    for (const listener of bus.endListeners) listener();
    await vi.waitFor(async () => expect((await f.queue.get(child.id)).state).toBe('released'));
    expect(warned()).toContain(`[child-agent] run of ${child.id} failed: error: Session ${child.id} not found`);
    expect((await host.wait({ chatIds: [child.id], timeoutMs: 0 })).items[0]).toMatchObject({
      status: 'failed', reason: `error: Session ${child.id} not found` });
  });
});
