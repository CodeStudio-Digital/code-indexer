/**
 * The host's part of background children and approvals: the end of a
 * background run sends the parent a notice that wakes it when idle (through
 * the collaboration wake service) and again after an app restart; an approval
 * prompt in a child shows in the parent's notification stream and resolves
 * when answered or when the run ends; a message to a child agent wakes it
 * through its tree admission, never with a direct run.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { formatChatMessage, rootChatId, type ChatMessage } from '@mcp/session-storage/collaboration/store.js';
import { childFixture, hostHarness, type ChildHostFixture } from './child-agent-host-fixture.js';

vi.mock('../../../../sse/coderWorkerPoolSingleton.js', () => ({ getCoderWorkerPool: () => { throw new Error('the test passes its own pool'); } }));
vi.mock('../../../../control-plane-shadow.js', () => ({
  acceptLocalCoderCommand: vi.fn(), bindLocalCommandBus: vi.fn(), terminalizeLocalCoderCommand: vi.fn(),
}));
vi.mock('../../../../custom-agents.js', () => ({ resolveAgentSelection: vi.fn() }));

const { createChildAgentHost } = await import('../child-agent-host.js');
const { childAgentAttention } = await import('../child-agent-attention.js');
const { startCollaborationWakeService } = await import('../chat-collaboration-wake.js');

let f: ChildHostFixture;
const h = hostHarness(createChildAgentHost, () => f);
const stops: Array<() => Promise<void>> = [];

/** The wake service as chat-collaboration.ts wires it: child agents through the host, the rest to `wakeRoot`. */
async function wakeService(host: ReturnType<typeof h.makeHost>, wakeRoot: (message: ChatMessage) => Promise<boolean>) {
  const stop = await startCollaborationWakeService(f.mailbox, async (message) => (await host.wake(message)) ?? wakeRoot(message),
    () => host.deliverCompletions().then(() => undefined));
  stops.push(stop);
}

beforeEach(async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined); // no provider DB in this fixture
  f = await childFixture('child-agent-host-notices-');
  h.reset();
});
afterEach(async () => {
  for (const stop of stops.splice(0)) await stop();
  vi.restoreAllMocks();
  await f.close();
});

describe('child-agent host: background completion, approvals and wakes', () => {
  it('wakes an idle parent with the notice of a background run, once', async () => {
    const host = h.makeHost();
    const woken = vi.fn(async (_message: ChatMessage) => true);
    await wakeService(host, woken);
    const { child } = await host.create(f.rootId, { key: 'bg', title: 'bg', profile: 'explore', task: 'do bg', wait: false });
    await f.holdLease(child.id);
    await f.conclude(child.id, 'Background done.');
    h.endRun(child.id);
    await expect.poll(() => woken.mock.calls.length, { timeout: 5_000 }).toBeGreaterThan(0);
    const notices = woken.mock.calls.map(([message]) => message);
    expect(new Set(notices.map((message) => message.id)).size).toBe(1);
    expect(notices[0]).toMatchObject({ from: rootChatId(child.id), to: rootChatId(f.rootId), kind: 'task' });
    expect(notices[0]!.body).toContain('Background done.');
  });

  it('wakes the parent after an app restart when the run ended while the app was down', async () => {
    const host = h.makeHost();
    const { child } = await host.create(f.rootId, { key: 'bg', title: 'bg', profile: 'explore', task: 'do bg', wait: false });
    await f.holdLease(child.id);
    await f.conclude(child.id, 'Done while down.');
    await f.restart(); // the app went down before the end of the run reached it
    h.buses = new Map();
    const restarted = h.makeHost();
    await restarted.service.resume(); // the boot path: resume, then deliver
    await restarted.deliverCompletions();
    const woken = vi.fn(async (_message: ChatMessage) => true);
    await wakeService(restarted, woken);
    await expect.poll(() => woken.mock.calls.length, { timeout: 5_000 }).toBeGreaterThan(0);
    expect(woken.mock.calls[0]![0].body).toContain('Done while down.');
  });

  it("shows a child's approval prompt in the parent's notifications and resolves it", async () => {
    const published: Array<{ sessionId: string; event: string; data: any }> = [];
    const host = h.makeHost({ attention: childAgentAttention((event) => { published.push(event as never); return null; }) });
    const { child } = await host.create(f.rootId, { key: 'a', title: 'Fix the parser', profile: 'explore', task: 'do a' });
    h.emit(child.id, 'tool_approval_request');
    h.emit(child.id, 'tool_approval_resolved');
    h.emit(child.id, 'tool_approval_request');
    h.endRun(child.id); // a prompt left open resolves with the run
    expect(published.map(({ sessionId, event, data }) => [sessionId, event, data.childId, data.state])).toEqual([
      [f.rootId, 'child_agent_attention', child.id, 'awaiting_approval'],
      [f.rootId, 'child_agent_attention', child.id, 'resolved'],
      [f.rootId, 'child_agent_attention', child.id, 'awaiting_approval'],
      [f.rootId, 'child_agent_attention', child.id, 'resolved'],
    ]);
    expect(published[0]!.data).toMatchObject({ childTitle: 'Fix the parser', projectId: 1 });
  });

  it('wakes a child agent through its tree admission, never past the running cap', async () => {
    const host = h.makeHost();
    const running: string[] = [];
    for (const key of ['a', 'b', 'c']) running.push((await host.create(f.rootId, { key, title: key, profile: 'explore', task: `do ${key}` })).child.id);
    const { child } = await host.create(f.rootId, { key: 'd', title: 'd', profile: 'explore', task: 'do d', start: false });
    const message = await f.mailbox.send({ from: rootChatId(f.rootId), to: rootChatId(child.id), kind: 'task', body: 'Also check the tests.', idempotencyKey: 'm1' });
    expect(await host.wake(message)).toBe(false); // the tree runs three: d waits in the queue
    expect(h.runFresh).toHaveBeenCalledTimes(3);
    expect(await f.queue.get(child.id)).toMatchObject({ state: 'queued', background: true });
    await f.conclude(running[0]!, 'A done.');
    h.endRun(running[0]!);
    await expect.poll(() => h.runFresh.mock.calls.length, { timeout: 2_000 }).toBe(4);
    expect(h.runFresh.mock.calls[3]).toMatchObject([child.id, { userMessage: `<agent_message>\n${formatChatMessage(message)}\n</agent_message>` }]);
    expect(await host.wake(message)).toBe(false); // already running: its mailbox delivers at the turn boundary
    expect(await host.wake({ ...message, to: rootChatId(f.rootId) })).toBeNull(); // a root chat: the usual wake
  });
});
