/**
 * The direct catalog with child chats: create_chat and send_chat_message are
 * direct, in an alphabetical array; a tool that would always be refused takes
 * no place (sub-agents disabled by the admin, a read-only root agent), and
 * talk with no one to answer is deferred; plan mode keeps create_chat (its
 * children are read-only); a child session gets create_chat only while
 * writable and below depth 4; Ultra adds workflow; Company has its mailbox
 * tools and no child chats. Unrelated core tools are stubs.
 */
import { describe, expect, it } from 'vitest';
import type { CoderTool } from '../../core/tool.js';
import { readOnlySessionAuthority } from '../../core/policy.js';
import { chatToolsForRun, withTalkDeferred } from '../chat-tool-set.js';
import { selectWorkflowCatalog } from '../workflow-catalog.js';
import { loadChildAgentRun } from '../../runtime/child-agent-run.js';

const stub = (name: string, extra: Partial<CoderTool> = {}): CoderTool =>
  ({ name, description: name, source: 'native', parameters: { type: 'object', properties: {} }, handler: async () => ({ content: '' }), ...extra });
const CORE = ['find_tools', 'code_exec', 'glob', 'read_file', 'apply_patch', 'edit_file', 'ask_user', 'task_list', 'exec_command', 'write_stdin']
  .map((name) => stub(name, name === 'ask_user' || name === 'task_list' ? { interactive: true } : {}));
const DELEGATION = new Set(['create_chat', 'send_chat_message', 'spawn_agent', 'resume_agent', 'collect_agents', 'reply_chat_message', 'workflow']);

function direct(authorized: readonly CoderTool[], company?: { isMaster: boolean }): string[] {
  return selectWorkflowCatalog(authorized, { activeTiers: null, cap: 64, ...(company ? { company } : {}) }).tools
    .map((tool) => tool.name).sort((a, b) => a.localeCompare(b));
}
const delegation = (names: string[]) => names.filter((name) => DELEGATION.has(name));
const on = (extra: Partial<Parameters<typeof chatToolsForRun>[0]> = {}) => [...CORE, ...chatToolsForRun({ company: false, ...extra })];

describe('direct catalog with child chats', () => {
  it('is the alphabetical pair', () => {
    expect(delegation(direct(on()))).toEqual(['create_chat', 'send_chat_message']);
    const names = direct(on());
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
  });

  it('gives no place to a tool that would always be refused, nor direct talk with no one to answer', () => {
    // Sub-agents disabled or a read-only root (Explore): runCoder registers no create_chat or stop_chat and,
    // without an Agêntico network, defers send_chat_message (callable from code_exec).
    const lone = on({ cannotDelegate: true }).map(withTalkDeferred);
    expect(delegation(direct(lone))).toEqual([]);
    expect(delegation(direct(readOnlySessionAuthority(lone)))).toEqual([]);
    // With an Agêntico network someone can answer: send_chat_message is not deferred, so it stays direct.
    expect(delegation(direct(on({ cannotDelegate: true })))).toEqual(['send_chat_message']);
    // Plan mode is not an authority filter: create_chat stays and makes read-only children.
    expect(delegation(direct(on()))).toContain('create_chat');
  });

  it('adds workflow under Ultra and keeps the pair', () => {
    expect(delegation(direct([...on(), stub('workflow')]))).toEqual(['create_chat', 'send_chat_message', 'workflow']);
  });

  it('gives a child create_chat only while writable and below depth 4', async () => {
    const childDirect = async (profile: string, depth: number, readOnly: boolean) => {
      const run = (await loadChildAgentRun({ getChildAgentSession: async () => ({ id: 'c', parent_session_id: 'p', depth, profile, read_only: readOnly } as never) },
        'c'))!;
      return delegation(direct(on().filter((tool) => run.allowsTool(tool))));
    };
    for (const profile of ['explore', 'review', 'verify', 'implement', 'full']) {
      expect(await childDirect(profile, 1, false)).toEqual(['create_chat', 'send_chat_message']);
      expect(await childDirect(profile, 4, false)).toEqual(['send_chat_message']);
      expect(await childDirect(profile, 2, true)).toEqual(['send_chat_message']);
    }
  });

  it('gives Company its mailbox tools and no child chats', () => {
    const company = chatToolsForRun({ company: true }).map((tool) => tool.name);
    for (const name of ['create_chat', 'stop_chat', 'wait_chats', 'read_chat']) expect(company).not.toContain(name);
    expect(company).toContain('reply_chat_message');
  });
});
