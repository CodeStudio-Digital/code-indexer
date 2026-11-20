/**
 * The app's ChildChatPort over the child-agent host (fake pool, real stores):
 * a caller waits only for its descendants and messages only its children; a
 * task to a running child goes through the mailbox, a task to a child that
 * is not running (finished or stopped) is its next run, started explicitly;
 * the list shows each child with its state.
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
const { createChildChatPort } = await import('../child-chat-caller.js');

let f: ChildHostFixture;
const h = hostHarness(createChildAgentHost, () => f);
const settle = () => new Promise((done) => setTimeout(done, 100));
const setup = () => {
  const host = h.makeHost();
  return { host, port: createChildChatPort(host, { sessions: f.app, mailbox: f.mailbox }) };
};

beforeEach(async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined); // no provider DB in this fixture
  f = await childFixture('child-chat-caller-');
  h.reset();
});
afterEach(async () => { vi.restoreAllMocks(); await f.close(); });

describe('child-chat port over the host', () => {
  it('creates as the caller, and waits only for its own descendants', async () => {
    const { port } = setup();
    const created = await port.create(f.rootId, { key: 'k1', title: 'Find it', profile: 'explore', task: 'Find the bug.' });
    expect(created).toMatchObject({ title: 'Find it', profile: 'explore', readOnly: false, created: true });
    expect(h.runFresh).toHaveBeenCalledWith(created.chatId, expect.objectContaining({ userMessage: 'Find the bug.' }));
    const other = (await f.app.createSession({ project_id: 1, title: 'Other', provider: 'p1', model: 'm1', agent: 'build' })).id;
    await expect(port.wait(other, { chatIds: [created.chatId], timeoutMs: 0 })).rejects.toThrow('is not a child chat of this session');
    expect((await port.wait(f.rootId, { chatIds: [created.chatId], timeoutMs: 0 })).items[0]).toMatchObject({ status: 'running' });
  });

  it('sends a task to a running child through the mailbox, and to a finished one as its next run', async () => {
    const { port } = setup();
    const { chatId } = await port.create(f.rootId, { key: 'k1', title: 'a', profile: 'explore', task: 'first' });
    await f.holdLease(chatId);
    const live = await port.message(f.rootId, chatId, { kind: 'task', message: 'also this', key: 'k2', background: false });
    expect(live?.messageId).toBeTruthy();
    expect((await f.mailbox.get(live!.messageId!))).toMatchObject({ from: rootChatId(f.rootId), to: rootChatId(chatId), kind: 'task' });
    await f.conclude(chatId, 'First done.');
    h.endRun(chatId);
    await settle();
    const next = await port.message(f.rootId, chatId, { kind: 'task', message: 'second', key: 'k3', background: false });
    expect(next?.messageId).toBeUndefined();
    expect(h.runFresh.mock.calls.at(-1)).toMatchObject([chatId, { userMessage: 'second' }]);
    expect(await f.queue.get(chatId)).toMatchObject({ state: 'admitted', requested_at: next!.since });
  });

  it('starts a stopped child again on an explicit task, refuses tasks to writers while read-only, and ignores non-children', async () => {
    const { host, port } = setup();
    const { chatId } = await port.create(f.rootId, { key: 'k1', title: 'a', profile: 'implement', task: 'first' });
    await f.holdLease(chatId);
    await host.stop(f.rootId, [chatId]);
    await settle();
    await expect(port.message(f.rootId, chatId, { kind: 'task', message: 'x', key: 'k2', background: false, readOnlyTargetsOnly: true }))
      .rejects.toThrow(/tasks go only to read-only child chats/);
    expect(await port.message(f.rootId, chatId, { kind: 'task', message: 'start over', key: 'k3', background: true })).toBeTruthy();
    expect(h.runFresh.mock.calls.at(-1)).toMatchObject([chatId, { userMessage: 'start over' }]);
    expect(await port.message(chatId, f.rootId, { kind: 'question', message: 'q', key: 'k4', background: false })).toBeNull();
  });

  it('lists the children with their state', async () => {
    const { port } = setup();
    const a = await port.create(f.rootId, { key: 'a', title: 'Alpha', profile: 'explore', task: 'a' });
    const b = await port.create(f.rootId, { key: 'b', title: 'Beta', profile: 'review', task: 'b', start: false });
    const listed = await port.list(f.rootId);
    expect(listed.map((item) => [item.chatId, item.title, item.profile, item.status]).sort()).toEqual([
      [a.chatId, 'Alpha', 'explore', 'running'], [b.chatId, 'Beta', 'review', 'idle']].sort());
  });
});
