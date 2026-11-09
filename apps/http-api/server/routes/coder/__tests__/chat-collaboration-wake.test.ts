import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { ChatCollaborationStore } from '@mcp/session-storage/collaboration/store.js';
import { startCollaborationWakeService, wakeCollaboratingChat } from '../chat-collaboration-wake.js';

const mocks = vi.hoisted(() => ({ runFresh: vi.fn(), getBus: vi.fn(), accept: vi.fn(), bind: vi.fn(), terminalize: vi.fn(), resolveAgent: vi.fn() }));
vi.mock('../../../../sse/coderWorkerPoolSingleton.js', () => ({ getCoderWorkerPool: () => mocks }));
vi.mock('../../../../control-plane-shadow.js', () => ({ acceptLocalCoderCommand: mocks.accept, bindLocalCommandBus: mocks.bind, terminalizeLocalCoderCommand: mocks.terminalize }));
vi.mock('../../../../custom-agents.js', () => ({ resolveAgentSelection: mocks.resolveAgent }));
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.reverse()) await cleanup(); cleanups.length = 0; vi.resetAllMocks(); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'chat-wake-')); cleanups.push(() => rm(root, { recursive: true, force: true }));
  const store = new ChatCollaborationStore(root); await store.init(); await store.registerRoot('00000000-0000-4000-8000-000000000001', 'Sender'); await store.registerRoot('00000000-0000-4000-8000-000000000002', 'Recipient'); await store.linkSessions('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002', true);
  return store;
}
it('wakes idle chats through agent admission, preserves recipient permissions, and never interrupts an active/human-waiting/stopped chat', async () => {
  const store = await fixture();
  const request = await store.send({ from: 'chat:00000000-0000-4000-8000-000000000001', to: 'chat:00000000-0000-4000-8000-000000000002', kind: 'task', body: 'Review', idempotencyKey: 'one' });
  const deps = { sessionStore: { getSession: vi.fn().mockResolvedValue({ id: '00000000-0000-4000-8000-000000000002', agent: 'explore', provider: 'test', model: 'test' }) }, providerStore: {}, controlPlaneStore: {} };
  const runtime = { findPendingInteraction: vi.fn().mockResolvedValue(null) };
  mocks.resolveAgent.mockReturnValue({ baseAgentId: 'explore', selectionId: 'explore', custom: { toolNames: ['read_file'], prompt: 'Read only.' } });
  mocks.accept.mockResolvedValue({ outcome: 'accepted', commandContext: {} }); mocks.bind.mockResolvedValue(true);
  const bus = { busId: 'bus', ended: false, endListeners: new Set<() => void>(), endReason: { event: 'done', data: { reason: 'completed' } }, ctrl: new AbortController() };
  mocks.runFresh.mockResolvedValue(bus);
  mocks.getBus.mockReturnValue({ ended: false });
  expect(await wakeCollaboratingChat(deps as never, runtime as never, store, request)).toBe(false);
  mocks.getBus.mockReturnValue(null); runtime.findPendingInteraction.mockResolvedValueOnce({ kind: 'approval' });
  expect(await wakeCollaboratingChat(deps as never, runtime as never, store, request)).toBe(false);
  expect(mocks.accept).not.toHaveBeenCalled();
  expect(await wakeCollaboratingChat(deps as never, runtime as never, store, request)).toBe(true);
  expect(mocks.accept.mock.calls[0][0].actor.actorType).toBe('agent');
  expect(mocks.runFresh.mock.calls[0][1]).toMatchObject({ agent: 'explore', allowedToolNames: ['read_file'] });
  expect((await store.get(request.id)).status).toBe('delivered');
  expect(await wakeCollaboratingChat(deps as never, runtime as never, store, request)).toBe(false);
  bus.ended = true; for (const listener of bus.endListeners) listener();
  await vi.waitFor(() => expect(mocks.terminalize).toHaveBeenCalledWith(deps.controlPlaneStore, expect.anything(), expect.objectContaining({ status: 'succeeded' })));
  const stopped = await store.send({ from: 'chat:00000000-0000-4000-8000-000000000001', to: 'chat:00000000-0000-4000-8000-000000000002', kind: 'task', body: 'Later', idempotencyKey: 'two' });
  await store.stopSession('00000000-0000-4000-8000-000000000002');
  expect(await wakeCollaboratingChat(deps as never, runtime as never, store, stopped)).toBe(false);
});
it('recovers old pending work behind recent history and does not wake on notifications', async () => {
  const store = await fixture();
  const request = await store.send({ from: 'chat:00000000-0000-4000-8000-000000000001', to: 'chat:00000000-0000-4000-8000-000000000002', kind: 'question', body: 'Old pending question', idempotencyKey: 'old' });
  await Promise.all(Array.from({ length: 505 }, (_, index) => store.files.put('messages', `history-${index}`, { ...request, id: `history-${index}`, kind: 'notify', createdAt: request.createdAt + index + 1 })));
  const wake = vi.fn(async message => { await store.acknowledge(message.to, message.id); return true; });
  const project = vi.spyOn(store, 'project');
  const stop = await startCollaborationWakeService(store, wake); cleanups.push(stop);
  await vi.waitFor(() => expect(wake).toHaveBeenCalledWith(expect.objectContaining({ id: request.id })), { timeout: 5000 });
  expect(wake).toHaveBeenCalledTimes(1);
  expect(project.mock.calls.some(([message]) => message.kind === 'notify')).toBe(false);
}, 15_000);
