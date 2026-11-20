/**
 * The child-chat switch (CODER_CHILD_SESSION_AGENTS): off (the default) or
 * in Company, a run registers today's chat tools in today's order and no
 * replaced name answers differently; on, the six child-chat tools take their
 * place, create_chat and send_chat_message are direct in normal and Agêntico
 * sessions alike, the other four are deferred, and every replaced name
 * answers with its replacement.
 */
import { describe, expect, it } from 'vitest';
import type { CoderTool } from '../../core/tool.js';
import { ToolRegistry } from '../../core/registry.js';
import { chatCollaborationTools } from '../chat-collaboration.js';
import { sessionNetworkTools } from '../session-network.js';
import { ultraFollowupTools } from '../ultra-followups.js';
import { chatToolsForRun } from '../chat-tool-set.js';
import { childSessionAgentsEnabled, REPLACED_BY_CHILD_CHATS } from '../child-chat-surface.js';
import { selectWorkflowCatalog } from '../workflow-catalog.js';

const names = (tools: readonly CoderTool[]) => tools.map((tool) => tool.name);
const RETIRED = ['spawn_agent', 'collect_agents', 'resume_agent', 'read_agent_transcript', 'resume_chat',
  'reply_chat_message', 'wait_chat_response', 'cancel_chat_request', 'list_project_chats', 'read_chat_messages'];
const stub = (name: string, extra: Partial<CoderTool> = {}): CoderTool =>
  ({ name, description: name, source: 'native', parameters: { type: 'object', properties: {} }, handler: async () => ({ content: name }), ...extra });

describe('child-chat switch', () => {
  it('is on unless explicitly turned off with 0 or false', () => {
    expect(childSessionAgentsEnabled({})).toBe(true);
    expect(childSessionAgentsEnabled({ CODER_CHILD_SESSION_AGENTS: '' })).toBe(true);
    expect(childSessionAgentsEnabled({ CODER_CHILD_SESSION_AGENTS: '1' })).toBe(true);
    expect(childSessionAgentsEnabled({ CODER_CHILD_SESSION_AGENTS: 'yes' })).toBe(true);
    expect(childSessionAgentsEnabled({ CODER_CHILD_SESSION_AGENTS: '0' })).toBe(false);
    expect(childSessionAgentsEnabled({ CODER_CHILD_SESSION_AGENTS: ' FALSE ' })).toBe(false);
  });

  it('leaves out create_chat and stop_chat where delegation would always be refused', () => {
    const names = chatToolsForRun({ childChats: true, company: false, cannotDelegate: true }).map((tool) => tool.name);
    expect(names).toEqual(['send_chat_message', 'read_chat', 'wait_chats', 'list_chats', 'create_chat_trigger', 'propose_task', 'prepare_chat_schedule']);
  });

  it("registers exactly today's chat tools, in order, when off or in Company", () => {
    const today = [...chatCollaborationTools, ...sessionNetworkTools, ...ultraFollowupTools];
    expect(chatToolsForRun({ childChats: false, company: false })).toEqual(today);
    expect(chatToolsForRun({ childChats: false, company: true })).toEqual([...chatCollaborationTools]);
    expect(chatToolsForRun({ childChats: true, company: true })).toEqual([...chatCollaborationTools]);
  });

  it('registers the six child-chat tools and keeps only the trigger and the follow-ups when on', () => {
    const on = names(chatToolsForRun({ childChats: true, company: false }));
    expect(on).toEqual(['create_chat', 'send_chat_message', 'read_chat', 'wait_chats', 'stop_chat', 'list_chats',
      'create_chat_trigger', 'propose_task', 'prepare_chat_schedule']);
    for (const name of RETIRED) expect(on).not.toContain(name);
    expect(Object.keys(REPLACED_BY_CHILD_CHATS).sort()).toEqual([...RETIRED].sort());
  });

  it('answers a replaced name with its replacement only when the run replaced it and does not register it', async () => {
    const off = new ToolRegistry();
    expect((await off.invoke('spawn_agent', {}, { cwd: '.', projectName: 'p' } as never)).error?.code).toBe('UNKNOWN_TOOL');
    const on = new ToolRegistry();
    on.setReplacedTools(REPLACED_BY_CHILD_CHATS);
    for (const name of RETIRED) {
      const result = await on.invoke(name, {}, { cwd: '.', projectName: 'p' } as never);
      expect(result).toMatchObject({ isError: true, error: { code: 'RETIRED_TOOL' } });
      expect(result.content).toContain(`${name} was retired. ${REPLACED_BY_CHILD_CHATS[name]}`);
    }
    const registered = new ToolRegistry();
    registered.setReplacedTools(REPLACED_BY_CHILD_CHATS);
    registered.register(stub('spawn_agent'));
    expect((await registered.invoke('spawn_agent', {}, { cwd: '.', projectName: 'p' } as never)).content).toBe('spawn_agent');
  });

  it('puts create_chat and send_chat_message in the direct catalog of normal and Agêntico sessions, the rest deferred', () => {
    const authorized = [stub('find_tools'), stub('code_exec'), stub('read_file'), ...chatToolsForRun({ childChats: true, company: false })];
    for (const agenticChat of [false, true]) {
      const direct = names(selectWorkflowCatalog(authorized, { activeTiers: null, cap: 64, agenticChat }).tools);
      expect(direct).toEqual(expect.arrayContaining(['create_chat', 'send_chat_message']));
      for (const deferred of ['read_chat', 'wait_chats', 'stop_chat', 'list_chats', 'create_chat_trigger']) expect(direct).not.toContain(deferred);
    }
    const today = [stub('find_tools'), stub('code_exec'), stub('read_file'), ...chatToolsForRun({ childChats: false, company: false })];
    expect(names(selectWorkflowCatalog(today, { activeTiers: null, cap: 64, agenticChat: false }).tools)).not.toContain('create_chat');
  });
});
