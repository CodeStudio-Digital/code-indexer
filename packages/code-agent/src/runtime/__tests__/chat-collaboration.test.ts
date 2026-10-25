import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { ChatCollaborationStore, childChatId, rootChatId } from '@mcp/session-storage/collaboration/store.js';
import { runParallelAgents, runSubagent } from '../../tools/implement-subagent.js';
import { chatCollaborationTools } from '../../tools/chat-collaboration.js';
import type { ChatProvider } from '../../providers/adapter.js';
import type { ChatDelta } from '../../core/messages.js';
import type { ToolContext } from '../../core/tool.js';
import { attachChatMailbox } from '../chat-collaboration.js';

const roots: string[] = [];
const activeRuns: Promise<unknown>[] = [];
const controllers: AbortController[] = [];
afterEach(async () => {
  for (const controller of controllers.splice(0)) controller.abort();
  await Promise.allSettled(activeRuns.splice(0));
  for (const path of roots.splice(0)) await rm(path, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'ultra-chats-')); roots.push(root);
  const store = new ChatCollaborationStore(root); await store.init(); await store.registerRoot('session', 'Owner');
  const a = childChatId('session', 'a'), b = childChatId('session', 'b');
  for (const id of [a, b]) await store.register({ id, sessionId: 'session', parentId: rootChatId('session'), label: id, profile: 'explore', state: 'idle' });
  return { root, store, a, b };
}
function* call(id: string, name: string, input: Record<string, unknown>): Generator<ChatDelta> {
  yield { type: 'tool_call_start', id, name }; yield { type: 'tool_call_end', id, name, input }; yield { type: 'done', stop_reason: 'tool_use' };
}
it('two real runners exchange a question and correlated answer, retaining context for a follow-up', async () => {
  const { root, store, a, b } = await fixture();
  const controller = new AbortController(); controllers.push(controller);
  let announceQuestion!: () => void;
  const questionReady = new Promise<void>(resolve => { announceQuestion = resolve; });
  let stepA = 0, stepB = 0;
  const providerA: ChatProvider = { name: 'test', model: 'test', setModel() {}, async *chat() {
    if (++stepA === 1) { yield* call('ask', 'send_chat_message', { to: b, kind: 'question', message: 'Which contract should we use?' }); return; }
    if (stepA === 2) { const request = (await store.pending(a)).find(row => row.from === a)!; announceQuestion(); yield* call('wait', 'wait_chat_response', { request_id: request.id, timeout_s: 60 }); return; }
    yield { type: 'text_delta', text: 'I will preserve contract V2.' }; yield { type: 'done', stop_reason: 'end_turn' };
  } };
  const providerB: ChatProvider = { name: 'test', model: 'test', setModel() {}, async *chat(request) {
    if (++stepB === 1) {
      expect(JSON.stringify(request.messages)).toContain('Which contract');
      const question = (await store.pending(b)).find(row => row.kind === 'question')!;
      yield* call('reply', 'reply_chat_message', { request_id: question.id, message: 'Use contract V2; preserve compatibility.' }); return;
    }
    yield { type: 'text_delta', text: 'Review completed.' }; yield { type: 'done', stop_reason: 'end_turn' };
  } };
  const ctx = { cwd: root, sessionId: 'session', signal: controller.signal, collaboration: { actor: rootChatId('session'), store } } as ToolContext;
  const parent = (provider: ChatProvider) => ({ provider, tools: chatCollaborationTools, ctx, sessionId: 'session' as never });
  const runningA = runSubagent(parent(providerA), { allowlist: null, spawnId: 'a', profile: 'explore', systemPrompt: 'Coordinate.', initialMessages: [{ role: 'user', content: [{ type: 'text', text: 'Ask peer B.' }] }], maxTurns: 6 });
  activeRuns.push(runningA.catch(() => undefined));
  await Promise.race([questionReady, runningA.then(() => { throw new Error('Sender exited before publishing its question'); })]);
  const resultB = await runSubagent(parent(providerB), { allowlist: null, spawnId: 'b', profile: 'explore', systemPrompt: 'Review.', initialMessages: [{ role: 'user', content: [{ type: 'text', text: 'Answer the peer.' }] }], maxTurns: 4 });
  const resultA = await runningA;
  expect(resultA.reason).toBe('completed'); expect(resultB.reason).toBe('completed');
  expect(JSON.stringify(resultA.transcript)).toContain('Use contract V2');
  expect((await store.messages(a)).filter(row => row.kind === 'question')[0].status).toBe('answered');
  await store.send({ from: a, to: b, kind: 'task', body: 'Review the migration next.', idempotencyKey: 'followup' });
  const resume: ChatProvider = { name: 'test', model: 'test', setModel() {}, async *chat(request) {
    const context = JSON.stringify(request.messages); expect(context).toContain('Review completed'); expect(context).toContain('Review the migration next');
    yield { type: 'text_delta', text: 'Migration reviewed.' }; yield { type: 'done', stop_reason: 'end_turn' };
  } };
  expect((await runSubagent(parent(resume), { allowlist: null, spawnId: 'b', profile: 'explore', systemPrompt: 'Review.', initialMessages: resultB.transcript!, maxTurns: 2 })).reason).toBe('completed');
}, 60_000);

it('does not duplicate an admitted message already in retained history and cancels incoming work on stop', async () => {
  const { store, a, b } = await fixture();
  const request = await store.send({ from: a, to: b, kind: 'task', body: 'Review', idempotencyKey: 'task' });
  const runner = { pushUserMessage: vi.fn(), hasPendingUserMessages: () => false,
    messages: [{ role: 'user', content: [{ type: 'text', text: `<agent_message>{"messageId":"${request.id}"}</agent_message>` }] }] };
  const close = await attachChatMailbox(store, (await store.participant(b))!, runner);
  expect(runner.pushUserMessage).not.toHaveBeenCalled(); expect((await store.get(request.id)).status).toBe('delivered');
  await close(); await store.stopSession('session');
  expect((await store.get(request.id)).status).toBe('cancelled');
});

it('assigns distinct durable mailboxes to agents sharing the same spawn group', async () => {
  const { store, root } = await fixture();
  const provider: ChatProvider = { name: 'test', model: 'test', setModel() {}, async *chat() {
    yield { type: 'text_delta', text: 'Done' }; yield { type: 'done', stop_reason: 'end_turn' };
  } };
  const ctx = { cwd: root, sessionId: 'session', collaboration: { actor: rootChatId('session'), store } } as ToolContext;
  await runParallelAgents({ provider, tools: [], ctx, sessionId: 'session' as never },
    [0, 1].map(index => ({ spawnId: 'group', label: `Peer ${index}`, task: 'Review', profile: 'explore', maxTurns: 1 })),
    'Review', null, () => {});
  const peers = (await store.peers(rootChatId('session'))).filter(peer => peer.id.includes('/agent:group:'));
  expect(peers.map(peer => peer.id).sort()).toEqual([childChatId('session', 'group:0'), childChatId('session', 'group:1')]);
  for (const peer of peers) expect(await store.files.get('checkpoints', peer.id)).toMatchObject({ phase: 'complete' });
});
