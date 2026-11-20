/**
 * The contract of the six child-chat tools: risk, repetition, own timeout,
 * whether code_exec may call them; what a read-only session, plan mode and
 * the approval gate do with each; and which of them a child session gets
 * (create_chat and stop_chat only while writable and below depth 4).
 */
import { describe, expect, it } from 'vitest';
import type { CoderTool } from '../../core/tool.js';
import { evaluateToolInvocation, isReadOnlySessionInvocation, isReadOnlySessionTool, resolveToolMetadata } from '../../core/policy.js';
import { classifyForGate } from '../../core/permission-gate.js';
import { resolveToolTimeoutMs } from '../../core/tool-timeouts.js';
import { canInvokeInsideCodeExec } from '../code-exec-eligibility.js';
import { chatCollaborationTools } from '../chat-collaboration.js';
import { chatToolsForRun } from '../chat-tool-set.js';
import { loadChildAgentRun } from '../../runtime/child-agent-run.js';

const tools = new Map(chatToolsForRun({ company: false }).map((tool) => [tool.name, tool]));
const tool = (name: string) => tools.get(name)!;
const THIRTY_ONE_MINUTES = 31 * 60_000;

describe('child-chat tool contracts', () => {
  it.each([
    ['create_chat', 'read', 'volatile', THIRTY_ONE_MINUTES, false],
    ['send_chat_message', 'read', 'volatile', THIRTY_ONE_MINUTES, false],
    ['read_chat', 'read', 'volatile', null, true],
    ['wait_chats', 'read', 'pollable', THIRTY_ONE_MINUTES, true],
    ['stop_chat', 'read', 'stable', null, true],
    ['list_chats', 'read', 'volatile', null, true],
  ] as const)('%s: risk %s, repeat %s, timeout %s, inside code_exec %s', (name, risk, repeat, timeout, inCodeExec) => {
    const metadata = resolveToolMetadata(tool(name));
    expect(metadata).toMatchObject({ riskLevel: risk, mutates: false });
    expect(tool(name).repeatPolicy).toBe(repeat);
    if (timeout !== null) expect(resolveToolTimeoutMs(tool(name))).toBe(timeout);
    expect(canInvokeInsideCodeExec(tool(name))).toBe(inCodeExec);
    expect(tool(name).continues).toBeUndefined();
  });

  it('rates each send_chat_message call: a task delegates, asking, notifying and answering only talk', () => {
    const send = tool('send_chat_message');
    expect(send.riskOf?.({ to: 'c', message: 'm' })).toBe('admin');
    expect(send.riskOf?.({ to: 'c', message: 'm', kind: 'task' })).toBe('admin');
    for (const args of [{ kind: 'question' }, { kind: 'notify' }, { reply_to: 'r1' }]) expect(send.riskOf?.({ to: 'c', message: 'm', ...args })).toBe('read');
    // Never an approval prompt: the child's own calls are gated with what it inherited.
    expect(classifyForGate(send, 'send_chat_message', { to: 'c', message: 'm', kind: 'task' })).toBe('allow');
    expect(classifyForGate(tool('create_chat'), 'create_chat', {})).toBe('allow');
  });

  it('in a read-only session: no create_chat or stop_chat, only asking and notifying, and reading', () => {
    expect(isReadOnlySessionTool(tool('create_chat'))).toBe(false);
    expect(isReadOnlySessionTool(tool('stop_chat'))).toBe(false);
    for (const name of ['read_chat', 'wait_chats', 'list_chats']) expect(isReadOnlySessionInvocation(tool(name), {})).toBe(true);
    const send = tool('send_chat_message');
    expect(isReadOnlySessionInvocation(send, { to: 'c', message: 'm', kind: 'task' })).toBe(false);
    expect(isReadOnlySessionInvocation(send, { to: 'c', message: 'm', kind: 'question' })).toBe(true);
    expect(isReadOnlySessionInvocation(send, { to: 'c', message: 'm', reply_to: 'r1' })).toBe(true);
    const refusal = evaluateToolInvocation(send, { to: 'c', message: 'm' }, { readOnly: true, planMode: false } as never);
    expect(refusal).toMatchObject({ allowed: false, reason: 'read_only' });
    // Off: today's send_chat_message is still refused whole in a read-only session.
    expect(isReadOnlySessionTool(chatCollaborationTools.find((candidate) => candidate.name === 'send_chat_message')!)).toBe(false);
  });

  it('in plan mode none is blocked by the plan gate (none mutates); create_chat then makes read-only children', () => {
    for (const name of tools.keys()) {
      expect(evaluateToolInvocation(tool(name), {}, { readOnly: false, planMode: true, planApproved: false } as never).allowed).toBe(true);
    }
  });
});

describe('a child session (always outside Company, so with child chats)', () => {
  const child = (depth: number, readOnly: boolean) => loadChildAgentRun({
    getChildAgentSession: async () => ({ id: 'c', parent_session_id: 'p', depth, profile: 'implement', read_only: readOnly } as never),
  }, 'c');
  const admitted = async (depth: number, readOnly: boolean) => {
    const run = (await child(depth, readOnly))!;
    return [...tools.values()].filter((candidate: CoderTool) => run.allowsTool(candidate)).map((candidate) => candidate.name);
  };

  it('creates and stops children while writable and below depth 4, and always talks and reads', async () => {
    expect(await admitted(1, false)).toEqual(expect.arrayContaining(['create_chat', 'stop_chat', 'send_chat_message', 'read_chat', 'wait_chats', 'list_chats']));
    for (const [depth, readOnly] of [[4, false], [1, true]] as const) {
      const names = await admitted(depth, readOnly);
      expect(names).toEqual(expect.arrayContaining(['send_chat_message', 'read_chat', 'wait_chats', 'list_chats']));
      expect(names).not.toContain('create_chat');
      expect(names).not.toContain('stop_chat');
    }
  });

});
