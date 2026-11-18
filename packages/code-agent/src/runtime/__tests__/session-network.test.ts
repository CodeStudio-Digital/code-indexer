import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FsSessionStore } from '@mcp/session-storage/fs-store/index.js';
import { ChatCollaborationStore, rootChatId } from '@mcp/session-storage/collaboration/store.js';
import { SessionNetwork } from '../session-network.js';
import { deliverNetworkTriggers, reserveNetworkWake } from '../session-network-events.js';
import type { ChatNetworkConfig } from '@mcp/session-storage/collaboration/network-types.js';
import { sessionNetworkTools } from '../../tools/session-network.js';

describe('ordinary session networks', () => {
  let root: string, sessions: FsSessionStore, mailbox: ChatCollaborationStore, network: SessionNetwork, parentId: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'session-network-'));
    for (const path of ['data', 'one', 'two']) await mkdir(join(root, path));
    const project = (id: number) => [1, 2].includes(id) ? { id, name: `Project ${id}`, root_path: join(root, id === 1 ? 'one' : 'two') } : null;
    sessions = FsSessionStore.fromRoots({ dataDir: join(root, 'data'), projectRootResolver: {
      resolveProjectRoot: id => project(id)?.root_path,
      listProjectRoots: () => [1, 2].map(id => ({ project_id: id, root_path: project(id)!.root_path })),
    } });
    mailbox = new ChatCollaborationStore(join(root, 'data')); await mailbox.init();
    network = new SessionNetwork({ sessions, mailbox, project, validateModel: (provider, model) => {
      if (!['p1', 'p2'].includes(provider) || !['m1', 'm2'].includes(model)) throw new Error('Unavailable model');
    } });
    const parent = await sessions.createSession({ project_id: 1, title: 'Coordinator', provider: 'p1', model: 'm1', agent: 'explore' });
    parentId = parent.id; await mailbox.registerRoot(parent.id, parent.title);
  });
  afterEach(async () => { await sessions.close(); await rm(root, { recursive: true, force: true }); });

  it('requires agentic mode, keeps roles/models and creates retry-safe peer sessions across authorized projects', async () => {
    const input = { title: 'Reviewer', role: 'Investigate risks', provider: 'p2', model: 'm2', projectId: 2, start: true, prompt: 'Evaluate the proposal' };
    await expect(network.create(parentId, input, 'a')).rejects.toThrow('Enable agentic');
    await network.settings(parentId, { enabled: true });
    await expect(network.create(parentId, input, 'a')).rejects.toThrow('Mention');
    await network.references(parentId, [], [2]);
    const first = await network.create(parentId, input, 'a');
    const repeated = await network.create(parentId, input, 'a');
    expect(repeated.id).toBe(first.id);
    expect((await sessions.listSessions(2)).map(row => row.id)).toEqual([first.id]);
    expect(await network.config(first.id)).toMatchObject({ rootId: parentId, role: 'Investigate risks', enabled: true });
    expect(await network.session(first.id)).toMatchObject({ parent_session_id: parentId, provider: 'p2', model: 'm2', kind: 'coder', execution_mode_override: 'standard' });
    expect(await mailbox.messages(rootChatId(first.id))).toHaveLength(1);
    const second = await network.create(parentId, { title: 'Designer', role: 'Debate alternatives' }, 'b');
    expect(await mailbox.connected(first.id, second.id)).toBe(true);
    expect((await network.context(parentId))).toContain('Investigate risks');
    expect((await network.discover(parentId, 'Reviewer'))[0]?.id).toBe(first.id);
    expect((await network.session(first.id)).metadata?.network_root_id).toBe(parentId);
  });

  it('notifies after publishing a normal child and its initial task in the parent checkout', async () => {
    const worktree = join(root, 'one', 'worktree');
    const parent = await sessions.createSession({ project_id: 1, title: 'Worktree', provider: 'p1', model: 'm1',
      agent: 'explore', worktree_path: worktree, metadata: { worktree_workspace: true } });
    await network.settings(parent.id, { enabled: true });
    const published: Array<{ session: unknown; messages: unknown }> = [];
    const notify = vi.fn(async (id: string) => {
      published.push({ session: await network.session(id), messages: await mailbox.pending(rootChatId(id)) });
    });
    const runtime = new SessionNetwork({ ...network.options, onChatCreated: notify });
    const child = await runtime.create(parent.id, { title: 'Reviewer', role: 'Review', prompt: 'Review now', start: true }, 'reviewer');
    expect(notify).toHaveBeenCalledWith(child.id);
    expect(published).toEqual([{
      session: expect.objectContaining({ parent_session_id: parent.id, worktree_path: worktree, tool_profile: null }),
      messages: [expect.objectContaining({ kind: 'task', body: 'Review now' })],
    }]);
  });

  it('enforces a durable shared creation quota even across concurrent participants', async () => {
    await network.settings(parentId, { enabled: true, maxSessions: 2 });
    const outcomes = await Promise.allSettled(['a', 'b', 'c'].map(key => network.create(parentId, { title: key, role: 'Research' }, key)));
    expect(outcomes.filter(outcome => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(await sessions.listSessions(1)).toHaveLength(2);
    const config = await network.settings(parentId, { rootId: 'forged', enabled: true } as never);
    expect(config.rootId).toBe(parentId);
  });

  it('fires once after the next completion, includes the final answer and survives service recreation', async () => {
    await network.settings(parentId, { enabled: true });
    const source = await network.create(parentId, { title: 'Research', role: 'Investigate' }, 'source');
    await mailbox.files.put('completions', source.id, { sessionId: source.id, runId: 'old', reason: 'completed', at: Date.now() - 100 });
    const trigger = await network.trigger(parentId, { sourceSessionId: source.id, targetSessionId: parentId, event: 'completed', prompt: 'Synthesize findings', includeFinal: true }, 'dependency');
    await deliverNetworkTriggers(network);
    expect(await mailbox.messages(rootChatId(parentId))).toHaveLength(0);
    await sessions.appendMessage({ session_id: source.id, message: { role: 'assistant', phase: 'final_answer', content: [{ type: 'text', text: 'The feature is viable with a prototype.' }] } });
    await sessions.setCompactionBoundary(source.id, 'Summary', 1, 'manual');
    await mailbox.files.put('completions', source.id, { sessionId: source.id, runId: 'new', reason: 'completed', at: Date.now() });
    const restarted = new SessionNetwork({ ...network.options, mailbox: new ChatCollaborationStore(join(root, 'data')) });
    await deliverNetworkTriggers(restarted); await deliverNetworkTriggers(restarted);
    const messages = await mailbox.messages(rootChatId(parentId));
    expect(messages).toHaveLength(1);
    expect(messages[0]?.body).toContain('The feature is viable with a prototype.');
    expect(messages[0]?.from).toBe(rootChatId(source.id));
    expect(await mailbox.files.get('triggers', trigger.id)).toMatchObject({ status: 'fired', firedRunId: 'new' });
  });

  it('revokes disabled network automation and persists wake budgets across restarts', async () => {
    await network.settings(parentId, { enabled: true, maxWakeups: 1 });
    const child = await network.create(parentId, { title: 'Child', role: 'Research' }, 'child');
    expect(await reserveNetworkWake(network, child.id, 'message-1')).toBe(true);
    expect(await reserveNetworkWake(new SessionNetwork(network.options), child.id, 'message-1')).toBe(true);
    expect(await reserveNetworkWake(network, child.id, 'message-2')).toBe(false);
    await network.settings(parentId, {}, true);
    expect(await reserveNetworkWake(network, child.id, 'message-2')).toBe(true);
    await network.settings(parentId, { enabled: false });
    expect(await reserveNetworkWake(network, child.id, 'message-3')).toBe(false);
    await expect(network.create(child.id, { title: 'Grandchild', role: 'Research' }, 'nested')).rejects.toThrow('Enable agentic');
  });

  it('delivers the first unconsumed run and its own answer after clock rollback and two completions', async () => {
    await network.settings(parentId, { enabled: true });
    const source = await network.create(parentId, { title: 'Research', role: 'Investigate' }, 'ordered-source');
    await network.trigger(parentId, { sourceSessionId: source.id, targetSessionId: parentId, event: 'completed', prompt: 'Synthesize', includeFinal: true }, 'ordered-trigger');
    await mailbox.recordCompletion({ sessionId: source.id, runId: 'one', at: 1, reason: 'completed', finalText: 'First answer' });
    await mailbox.recordCompletion({ sessionId: source.id, runId: 'two', at: 0, reason: 'completed', finalText: 'Second answer' });
    await deliverNetworkTriggers(network);
    const messages = await mailbox.messages(rootChatId(parentId));
    expect(messages).toHaveLength(1); expect(messages[0].body).toContain('First answer');
    expect(messages[0].body).not.toContain('Second answer');
  });

  it('reads only authorized chats and does not initialize discovery for unused ordinary chats', async () => {
    expect(await network.context(parentId)).toBe('');
    const foreign = await sessions.createSession({ project_id: 2, title: 'Foreign', provider: 'p1', model: 'm1' });
    await expect(network.read(parentId, foreign.id)).rejects.toThrow('outside');
    await network.references(parentId, [foreign.id], []);
    expect(await network.read(parentId, foreign.id)).toMatchObject({ id: foreign.id, final: null });
    expect(await mailbox.files.get<ChatNetworkConfig>('networks', parentId)).not.toBeNull();
  });

  it('uses live ordinary participant activity and respects an explicit project filter', async () => {
    await network.settings(parentId, { enabled: true });
    await network.references(parentId, [], [2]);
    const local = await network.create(parentId, { title: 'Local', role: 'Research' }, 'local');
    const foreign = await network.create(parentId, { title: 'Foreign', role: 'Review', projectId: 2 }, 'foreign');
    const participant = (await mailbox.participant(local.chatId))!;
    await mailbox.register({ ...participant, state: 'running' });
    expect(await network.discover(parentId, '', true)).toEqual([expect.objectContaining({ id: local.id, status: 'running' })]);
    expect(await network.discover(parentId, '', false, 1)).toEqual([expect.objectContaining({ id: local.id })]);
    expect(await network.discover(parentId, '', false, 2)).toEqual([expect.objectContaining({ id: foreign.id })]);
  });

  it('executes the public tools with durable IDs and rejects Company contexts', async () => {
    const ctx = { sessionNetwork: network, sessionId: parentId, currentToolUseId: 'create-tool' } as never;
    const call = (name: string, args: Record<string, unknown>, context = ctx) => sessionNetworkTools.find(tool => tool.name === name)!.handler(args, context);
    await network.settings(parentId, { enabled: true });
    const creation = await call('create_chat', { title: 'Reviewer', role: 'Review', provider: 'p2', model: 'm2' });
    expect(creation.isError).not.toBe(true);
    const child = creation.structuredData as { id: string; chatId: string };
    expect(child.chatId).toBe(rootChatId(child.id));
    const discovery = await call('list_project_chats', { query: 'Reviewer' });
    expect((discovery.structuredData as unknown[])[0]).toMatchObject({ chatId: child.chatId, provider: 'p2' });
    const read = await call('read_chat', { session_id: child.chatId });
    expect(read.structuredData).toMatchObject({ id: child.id, final: null });
    const trigger = await call('create_chat_trigger', { sourceSessionId: child.id, targetSessionId: parentId, event: 'completed', prompt: 'Synthesize', includeFinal: true });
    expect(trigger.structuredData).toMatchObject({ status: 'waiting' });
    const blocked = await call('create_chat', { title: 'Forbidden', role: 'Review' }, { sessionNetwork: network, sessionId: parentId, companyContext: {} } as never);
    expect(blocked.isError).toBe(true);
    expect(await sessions.listSessions(1)).toHaveLength(2);
  });

  it('imports prepared worker-created chats into an already initialized host catalog', async () => {
    const hostSessions = FsSessionStore.fromRoots({ dataDir: join(root, 'data'), projectRootResolver: {
      resolveProjectRoot: id => join(root, id === 1 ? 'one' : 'two'),
      listProjectRoots: () => [1, 2].map(id => ({ project_id: id, root_path: join(root, id === 1 ? 'one' : 'two') })),
    } });
    try {
      expect(await hostSessions.listSessions(1)).toHaveLength(1);
      await network.settings(parentId, { enabled: true });
      const child = await network.create(parentId, { title: 'Prepared', role: 'Research', start: false }, 'prepared');
      expect(await hostSessions.getSession(child.id)).toBeNull();
      const hostNetwork = new SessionNetwork({ ...network.options, sessions: hostSessions });
      await hostNetwork.synchronize();
      expect(await hostSessions.getSession(child.id)).toMatchObject({ title: 'Prepared', status: 'idle' });
      expect(await hostSessions.listSessions(1)).toHaveLength(2);
    } finally { await hostSessions.close(); }
  });

  it('keeps unrelated triggers moving after an individual delivery fails', async () => {
    await network.settings(parentId, { enabled: true });
    const source = await network.create(parentId, { title: 'Source', role: 'Research' }, 'source');
    for (const key of ['first', 'second']) await network.trigger(parentId, {
      sourceSessionId: source.id, targetSessionId: parentId, event: 'completed', prompt: key, includeFinal: false,
    }, key);
    await mailbox.files.put('completions', source.id, { sessionId: source.id, runId: 'done', reason: 'completed', at: Date.now() });
    const send = vi.spyOn(mailbox, 'send').mockRejectedValueOnce(new Error('Transient delivery failure'));
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await deliverNetworkTriggers(network);
      expect(send).toHaveBeenCalledTimes(2);
      expect(await mailbox.pending()).toHaveLength(1);
      await deliverNetworkTriggers(network);
      expect(await mailbox.pending()).toHaveLength(2);
    } finally { send.mockRestore(); warning.mockRestore(); }
  });
});
