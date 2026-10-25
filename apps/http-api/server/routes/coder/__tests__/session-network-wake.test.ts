import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FsSessionStore } from '@mcp/session-storage/fs-store/index.js';
import { ChatCollaborationStore, rootChatId } from '@mcp/session-storage/collaboration/store.js';
import { SessionNetwork } from '@mcp/code-agent/runtime/session-network.js';
import { deliverNetworkTriggers } from '@mcp/code-agent/runtime/session-network-events.js';
import { startCollaborationWakeService, wakeCollaboratingChat } from '../chat-collaboration-wake.js';

const host = vi.hoisted(() => ({ getBus: vi.fn(), runFresh: vi.fn(), accept: vi.fn(), bind: vi.fn() }));
vi.mock('../../../../sse/coderWorkerPoolSingleton.js', () => ({ getCoderWorkerPool: () => host }));
vi.mock('../../../../custom-agents.js', () => ({ resolveAgentSelection: () => ({ baseAgentId: 'explore', selectionId: 'explore' }) }));
vi.mock('../../../../control-plane-shadow.js', () => ({ acceptLocalCoderCommand: host.accept, bindLocalCommandBus: host.bind, terminalizeLocalCoderCommand: vi.fn() }));
let directory: string, sessions: FsSessionStore, mailbox: ChatCollaborationStore, network: SessionNetwork, parentId: string;
let stop: (() => Promise<void>) | undefined;
beforeEach(async () => {
  vi.clearAllMocks();
  directory = await mkdtemp(join(tmpdir(), 'session-network-host-'));
  await mkdir(join(directory, 'project'));
  sessions = FsSessionStore.fromRoots({ dataDir: join(directory, 'data'), projectRootResolver: {
    resolveProjectRoot: () => join(directory, 'project'), listProjectRoots: () => [{ project_id: 1, root_path: join(directory, 'project') }],
  } });
  mailbox = new ChatCollaborationStore(join(directory, 'data')); await mailbox.init();
  network = new SessionNetwork({ sessions, mailbox, project: id => ({ id, name: 'Project', root_path: join(directory, 'project') }) });
  const parent = await sessions.createSession({ project_id: 1, title: 'Coordinator', provider: 'provider-a', model: 'model-a', agent: 'explore' });
  parentId = parent.id; await mailbox.registerRoot(parent.id, parent.title); await network.settings(parentId, { enabled: true });
  host.getBus.mockReturnValue(undefined);
  host.accept.mockResolvedValue({ outcome: 'accepted', runContext: { runId: 'fixture' } });
  host.bind.mockResolvedValue(true);
  host.runFresh.mockImplementation(async () => ({ busId: 'bus', ended: false, endListeners: new Set(), ctrl: new AbortController() }));
});
afterEach(async () => { await stop?.(); stop = undefined; await sessions.close(); await rm(directory, { recursive: true, force: true }); });

it('dispatches prepared ordinary sessions through host admission, then wakes the coordinator with their durable final answer', async () => {
  const child = await network.create(parentId, { title: 'Reviewer', role: 'Evaluate the design', provider: 'provider-b', model: 'model-b', start: true }, 'reviewer');
  const deps = { sessionStore: sessions, providerStore: {}, controlPlaneStore: {} } as never;
  const runtime = { findPendingInteraction: vi.fn(async () => null) } as never;
  await network.trigger(parentId, { sourceSessionId: child.id, targetSessionId: parentId, event: 'completed', prompt: 'Synthesize', includeFinal: true }, 'finished');
  stop = await startCollaborationWakeService(mailbox, message => wakeCollaboratingChat(deps, runtime, mailbox, message, network), () => deliverNetworkTriggers(network));
  await vi.waitFor(() => expect(host.runFresh).toHaveBeenCalledTimes(1));
  expect(host.runFresh.mock.calls[0]?.[0]).toBe(child.id);
  expect(host.accept.mock.calls[0]?.[0]).toMatchObject({ requestedProvider: 'provider-b', requestedModel: 'model-b', actor: { actorType: 'agent' } });
  expect(await network.context(child.id)).toContain('Evaluate the design');
  await sessions.appendMessage({ session_id: child.id, message: { role: 'assistant', phase: 'final_answer', content: [{ type: 'text', text: 'Proceed with the smaller feature.' }] } });
  await mailbox.files.put('completions', child.id, { sessionId: child.id, runId: 'completed-run', reason: 'completed', at: Date.now() });
  await vi.waitFor(() => expect(host.runFresh).toHaveBeenCalledTimes(2));
  expect(host.runFresh.mock.calls[1]?.[0]).toBe(parentId);
  expect(host.runFresh.mock.calls[1]?.[1].userMessage).toContain('Proceed with the smaller feature.');
  await deliverNetworkTriggers(network);
  expect(host.runFresh).toHaveBeenCalledTimes(2);
});

it('keeps a queued task pending while its target is active or awaiting a user interaction', async () => {
  const child = await network.create(parentId, { title: 'Reviewer', role: 'Evaluate', start: true }, 'reviewer');
  const message = (await mailbox.pending(rootChatId(child.id)))[0]!;
  const deps = { sessionStore: sessions, providerStore: {}, controlPlaneStore: {} } as never;
  host.getBus.mockReturnValue({ ended: false });
  expect(await wakeCollaboratingChat(deps, { findPendingInteraction: async () => null } as never, mailbox, message, network)).toBe(false);
  host.getBus.mockReturnValue(undefined);
  expect(await wakeCollaboratingChat(deps, { findPendingInteraction: async () => ({ name: 'ask_user' }) } as never, mailbox, message, network)).toBe(false);
  expect(host.runFresh).not.toHaveBeenCalled();
  expect((await mailbox.get(message.id)).status).toBe('queued');
});
