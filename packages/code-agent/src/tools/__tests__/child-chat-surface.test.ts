/**
 * The chat surface: in Company a run registers the six mailbox tools, in
 * their order, and no replaced name answers differently; elsewhere the six
 * child-chat tools take their place, create_chat and send_chat_message are
 * direct, the other four are deferred, and every replaced name answers with
 * its replacement.
 */
import { describe, expect, it } from 'vitest';
import type { CoderTool } from '../../core/tool.js';
import { ToolRegistry } from '../../core/registry.js';
import { chatCollaborationTools } from '../chat-collaboration.js';
import { chatToolsForRun } from '../chat-tool-set.js';
import { REPLACED_BY_CHILD_CHATS, replacedInCompany } from '../child-chat-surface.js';
import { selectWorkflowCatalog } from '../workflow-catalog.js';

const names = (tools: readonly CoderTool[]) => tools.map((tool) => tool.name);
const RETIRED = ['spawn_agent', 'collect_agents', 'resume_agent', 'read_agent_transcript', 'resume_chat',
  'reply_chat_message', 'wait_chat_response', 'cancel_chat_request', 'list_project_chats', 'read_chat_messages'];
const stub = (name: string, extra: Partial<CoderTool> = {}): CoderTool =>
  ({ name, description: name, source: 'native', parameters: { type: 'object', properties: {} }, handler: async () => ({ content: name }), ...extra });

describe('chat surface', () => {
  it('leaves out create_chat and stop_chat where delegation would always be refused', () => {
    const names = chatToolsForRun({ company: false, cannotDelegate: true }).map((tool) => tool.name);
    expect(names).toEqual(['send_chat_message', 'read_chat', 'wait_chats', 'list_chats', 'create_chat_trigger', 'propose_task', 'prepare_chat_schedule']);
  });

  it('registers the six mailbox tools, in their order, in Company', () => {
    expect(chatToolsForRun({ company: true })).toEqual([...chatCollaborationTools]);
    expect(chatToolsForRun({ company: true, cannotDelegate: true })).toEqual([...chatCollaborationTools]);
  });

  it('registers the six child-chat tools, the trigger and the follow-ups outside Company', () => {
    const outside = names(chatToolsForRun({ company: false }));
    expect(outside).toEqual(['create_chat', 'send_chat_message', 'read_chat', 'wait_chats', 'stop_chat', 'list_chats',
      'create_chat_trigger', 'propose_task', 'prepare_chat_schedule']);
    for (const name of RETIRED) expect(outside).not.toContain(name);
    expect(Object.keys(REPLACED_BY_CHILD_CHATS).sort()).toEqual([...RETIRED].sort());
  });

  it('answers a replaced name with its replacement only when the run replaced it and does not register it', async () => {
    const company = new ToolRegistry();
    expect((await company.invoke('spawn_agent', {}, { cwd: '.', projectName: 'p' } as never)).error?.code).toBe('UNKNOWN_TOOL');
    const outside = new ToolRegistry();
    outside.setReplacedTools(REPLACED_BY_CHILD_CHATS);
    for (const name of RETIRED) {
      const result = await outside.invoke(name, {}, { cwd: '.', projectName: 'p' } as never);
      expect(result).toMatchObject({ isError: true, error: { code: 'RETIRED_TOOL' } });
      expect(result.content).toContain(`${name} was retired. ${REPLACED_BY_CHILD_CHATS[name]}`);
    }
    const registered = new ToolRegistry();
    registered.setReplacedTools(REPLACED_BY_CHILD_CHATS);
    registered.register(stub('spawn_agent'));
    expect((await registered.invoke('spawn_agent', {}, { cwd: '.', projectName: 'p' } as never)).content).toBe('spawn_agent');
  });

  it('answers the retired delegation names in Company with its own tools', async () => {
    const ctx = { cwd: '.', projectName: 'p' } as never;
    const master = new ToolRegistry();
    master.setReplacedTools(replacedInCompany({ isMaster: true, workflow: false }));
    expect((await master.invoke('spawn_agent', {}, ctx)).content).toContain('spawn_agent was retired. Use spawn_subordinate_agent');
    for (const workflow of [false, true]) {
      const subordinate = new ToolRegistry();
      subordinate.setReplacedTools(replacedInCompany({ isMaster: false, workflow }));
      for (const name of ['spawn_agent', 'resume_agent', 'collect_agents', 'resume_chat', 'read_agent_transcript']) {
        const text = (await subordinate.invoke(name, {}, ctx)).content as string;
        expect(text).toContain(`${name} was retired.`);
        expect(text).toContain('in this session');
        expect(text.includes('workflow')).toBe(workflow);
      }
    }
  });

  it('puts create_chat and send_chat_message in the direct catalog, the rest deferred', () => {
    const authorized = [stub('find_tools'), stub('code_exec'), stub('read_file'), ...chatToolsForRun({ company: false })];
    const direct = names(selectWorkflowCatalog(authorized, { activeTiers: null, cap: 64 }).tools);
    expect(direct).toEqual(expect.arrayContaining(['create_chat', 'send_chat_message']));
    for (const deferred of ['read_chat', 'wait_chats', 'stop_chat', 'list_chats', 'create_chat_trigger']) expect(direct).not.toContain(deferred);
  });
});
