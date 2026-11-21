/**
 * The child-chat tools over a fake port: create_chat creates as this session
 * with the call id as its key and waits for the result; a planning or
 * read-only caller creates read-only children; the result carries the
 * child's usage claimed for this turn and spills a long answer;
 * send_chat_message gives a child its next task, asks, answers or reaches a
 * non-child through the mailbox; wait_chats stays within the call's deadline;
 * stop_chat and list_chats report what the port did.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '../../core/tool.js';
import { SUBAGENT_TOOL_RESULT_CAP } from '../../core/runner.js';
import type { ChildChatPort } from '../../ports/child-chat-port.js';
import { chatToolsForRun } from '../chat-tool-set.js';

const tools = new Map(chatToolsForRun({ company: false }).map((tool) => [tool.name, tool]));
const run = (name: string, args: Record<string, unknown>, ctx: ToolContext) => tools.get(name)!.handler(args, ctx);
const done = (chatId: string, finalText = 'Child answer.') => ({ outcome: 'ready' as const,
  items: [{ chatId, status: 'completed' as const, reason: 'completed', finalText, changedFiles: ['src/a.ts'] }] });

let port: { [K in keyof ChildChatPort]: ReturnType<typeof vi.fn> };
let store: { send: ReturnType<typeof vi.fn>; get: ReturnType<typeof vi.fn>; waitResult: ReturnType<typeof vi.fn>; peers: ReturnType<typeof vi.fn> };
let ctx: ToolContext;

beforeEach(() => {
  port = { create: vi.fn(async (_caller, request) => ({ chatId: 'c1', title: request.title, profile: request.profile, readOnly: !!request.parentReadOnly, created: true })),
    wait: vi.fn(async (_caller, request) => done(request.chatIds[0])), stop: vi.fn(async () => ({ stopped: ['c1', 'g1', 'g2'] })),
    message: vi.fn(async () => ({ since: '2026-11-20T00:00:00.000Z' })), list: vi.fn(async () => []) };
  store = { send: vi.fn(async (input) => ({ id: `m-${input.kind}`, ...input })), get: vi.fn(async (id) => ({ id, from: 'chat:c1' })),
    waitResult: vi.fn(async () => ({ reason: 'response', items: [{ id: 'r1', from: 'chat:p', body: 'Use main.' }] })), peers: vi.fn(async () => []) };
  ctx = { cwd: '.', projectName: 'p', sessionId: 'p' as never, currentToolUseId: 'call-1', childChats: port as unknown as ChildChatPort,
    collaboration: { store, actor: 'chat:p' } as never,
    childAgentAccounting: { claim: vi.fn(async () => ({ subUsage: { input_tokens: 9, output_tokens: 2 }, subUsageRuns: ['child-run:r1'] })), sweep: vi.fn() } as never,
    toolOutputStore: { put: vi.fn(() => 'out-1') } as never } as ToolContext;
});

describe('create_chat', () => {
  it.each([{}, { wait: false }])('returns a receipt without waiting for the child (%j)', async (options) => {
    const result = await run('create_chat', { title: 'Review', prompt: 'Review the code.', profile: 'review', ...options }, ctx);
    expect(port.create).toHaveBeenCalledWith('p', expect.objectContaining({ wait: false }));
    expect(result.content).toContain('Chat c1 (review) accepted for background execution');
    expect(port.wait).not.toHaveBeenCalled();
  });

  it('creates as this session, keyed by the call, waits and returns the answer with its usage for this turn', async () => {
    const result = await run('create_chat', { title: 'Find it', prompt: 'Find the bug.', profile: 'explore', wait: true }, ctx);
    expect(port.create).toHaveBeenCalledWith('p', expect.objectContaining({ key: 'call-1', title: 'Find it', task: 'Find the bug.', profile: 'explore', wait: true, parentReadOnly: false }));
    expect(port.create.mock.calls[0]![1]).not.toHaveProperty('effort');
    expect(port.wait).toHaveBeenCalledWith('p', expect.objectContaining({ chatIds: ['c1'], mode: 'all' }), undefined);
    expect(result).toMatchObject({ subUsage: { input_tokens: 9, output_tokens: 2 }, subUsageRuns: ['child-run:r1'] });
    expect(result.content).toBe('Chat c1: completed\nChanged files: src/a.ts\nAnswer:\nChild answer.');
  });

  it('advertises optional effort and forwards the requested level to the child', async () => {
    const schema = tools.get('create_chat')!.parameters;
    expect(schema.properties.effort).toMatchObject({ type: 'string' });
    expect(schema.required).not.toContain('effort');
    await run('create_chat', {
      title: 'Review', prompt: 'Review the cache.', profile: 'review',
      provider: 'openai-chatgpt', model: 'gpt-6.2-astra', effort: ' max ', wait: false,
    }, ctx);
    expect(port.create).toHaveBeenCalledWith('p', expect.objectContaining({
      provider: 'openai-chatgpt', model: 'gpt-6.2-astra', effort: 'max',
    }));
  });

  it.each(['Ultra', 3])('rejects a session mode or malformed effort (%j) before creating the child', async (effort) => {
    const result = await run('create_chat', { title: 'Review', prompt: 'Review the cache.', profile: 'review', effort }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/reasoning effort/i);
    expect(port.create).not.toHaveBeenCalled();
  });

  it('makes read-only children while planning or read-only, and returns at once without waiting', async () => {
    const planning = { ...ctx, planMode: true, runner: { isPlanApproved: () => false } } as unknown as ToolContext;
    await run('create_chat', { title: 't', prompt: 'p', profile: 'implement', wait: false }, planning);
    expect(port.create).toHaveBeenLastCalledWith('p', expect.objectContaining({ parentReadOnly: true, wait: false }));
    await run('create_chat', { title: 't', prompt: 'p', profile: 'implement', wait: false }, { ...ctx, childAgentSelf: { depth: 1, readOnly: true } });
    expect(port.create).toHaveBeenLastCalledWith('p', expect.objectContaining({ parentReadOnly: true }));
    expect(port.wait).not.toHaveBeenCalled();
  });

  it('requires a known profile and the port', async () => {
    expect((await run('create_chat', { title: 't', prompt: 'p', profile: 'writer' }, ctx)).isError).toBe(true);
    expect((await run('create_chat', { title: 't', prompt: 'p' }, ctx)).isError).toBe(true);
    expect((await run('create_chat', { title: 't', prompt: 'p', profile: 'explore' }, { ...ctx, childChats: undefined })).content).toMatch(/unavailable/);
  });

  it('reports a child that failed on the first line, with its reason; the tool itself did not fail', async () => {
    port.wait.mockResolvedValueOnce({ outcome: 'ready', items: [{ chatId: 'c1', status: 'failed', reason: 'start_failed: worker spawn refused' }] });
    const result = await run('create_chat', { title: 't', prompt: 'p', profile: 'explore', wait: true }, ctx);
    expect(result.content.split('\n')[0]).toBe('Chat c1: failed (start_failed: worker spawn refused)');
    expect(result.isError).toBeUndefined();
  });

  it('spills a long answer and points at it', async () => {
    port.wait.mockResolvedValueOnce(done('c1', 'x'.repeat(SUBAGENT_TOOL_RESULT_CAP + 10)));
    const result = await run('create_chat', { title: 't', prompt: 'p', profile: 'explore', wait: true }, ctx);
    expect(result.content).toContain('the full answer is tool output out-1');
    expect(result.content.length).toBeLessThan(SUBAGENT_TOOL_RESULT_CAP + 300);
  });
});

describe('send_chat_message', () => {
  it("gives a child its next task and waits for that run's answer", async () => {
    const result = await run('send_chat_message', { to: 'chat:c1', message: 'Now the tests.' }, ctx);
    expect(port.message).toHaveBeenCalledWith('p', 'c1', expect.objectContaining({ kind: 'task', message: 'Now the tests.', key: 'call-1', background: false }));
    expect(port.wait).toHaveBeenCalledWith('p', expect.objectContaining({ chatIds: ['c1'], since: { c1: '2026-11-20T00:00:00.000Z' } }), undefined);
    expect(result).toMatchObject({ subUsageRuns: ['child-run:r1'] });
  });

  it('reaches a non-child (the parent) through the mailbox and waits for the answer to a question', async () => {
    port.message.mockResolvedValueOnce(null);
    const result = await run('send_chat_message', { to: 'p0', message: 'Which branch?', kind: 'question' }, ctx);
    expect(store.send).toHaveBeenCalledWith(expect.objectContaining({ from: 'chat:p', to: 'chat:p0', kind: 'question', idempotencyKey: 'call-1' }));
    expect(result.content).toContain('Use main.');
  });

  it('answers with reply_to, and lets a read-only chat ask but not give tasks', async () => {
    expect((await run('send_chat_message', { to: 'c1', message: 'Yes.', reply_to: 'q1' }, ctx)).content).toContain('Answered message q1');
    expect(store.send).toHaveBeenCalledWith(expect.objectContaining({ kind: 'response', replyTo: 'q1', to: 'chat:c1' }));
    const readOnly = { ...ctx, childAgentSelf: { depth: 1, readOnly: true } };
    expect((await run('send_chat_message', { to: 'c1', message: 'Do it.' }, readOnly)).content).toMatch(/read-only chat can ask and notify/);
    await run('send_chat_message', { to: 'c1', message: 'FYI', kind: 'notify' }, readOnly);
    expect(port.message).toHaveBeenLastCalledWith('p', 'c1', expect.objectContaining({ kind: 'notify', readOnlyTargetsOnly: true }));
  });
});

describe('wait_chats, stop_chat, list_chats', () => {
  it('waits within the deadline of the call (inside code_exec: the script\'s)', async () => {
    await run('wait_chats', { chat_ids: ['c1'], timeout_s: 1800 }, { ...ctx, deadlineAtEpochMs: Date.now() + 8_000 });
    expect(port.wait.mock.calls[0]![1].timeoutMs).toBeLessThanOrEqual(3_000);
    await run('wait_chats', { chat_ids: ['c1', 'c2'], mode: 'all' }, ctx);
    expect(port.wait.mock.calls[1]![1]).toMatchObject({ chatIds: ['c1', 'c2'], mode: 'all', timeoutMs: 30 * 60_000 });
  });

  it('reports a stop with its descendants and lists children, linked chats and the project', async () => {
    expect((await run('stop_chat', { chat_id: 'c1' }, ctx)).content).toBe('Stopped chat c1 and 2 chats it started.');
    port.list.mockResolvedValueOnce([{ chatId: 'c1', title: 'Find it', profile: 'explore', depth: 1, readOnly: false, status: 'running' }]);
    expect((await run('list_chats', {}, ctx)).content).toBe('c1 — Find it (explore, depth 1): running');
    await run('list_chats', { scope: 'linked' }, ctx);
    expect(store.peers).toHaveBeenCalledWith('chat:p');
  });
});
