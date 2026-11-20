/**
 * What the model reads with child chats on: the subagents section and Ultra
 * collaboration name create_chat and send_chat_message (and fail closed
 * without create_chat), the Agêntico guidance and the shared tool texts drop
 * spawn_agent and its companions, the child's own section tells it to ask
 * its parent, and the code_exec hint names create_chat. With the switch off
 * every one of these texts is the old one.
 */
import { describe, expect, it } from 'vitest';
import { buildSystemPrompt, type PromptContext } from '../system-prompt.js';
import { resolveUltraPreset } from '../../sessions/ultra-policy.js';
import { REPLACED_BY_CHILD_CHATS } from '../../tools/child-chat-surface.js';
import { withChildChatTexts } from '../../tools/child-chat-texts.js';
import { CODE_EXEC_CATALOG_DESCRIPTION } from '../../tools/catalog-contracts.js';
import { WORKFLOW_DESC } from '../../tools/workflow/workflow-schema.js';
import { recallInvestigationsTool } from '../../tools/session-drive-tools.js';
import { buildCodeExecFailureHint } from '../../tools/code-exec-hints.js';
import { loadChildAgentRun } from '../../runtime/child-agent-run.js';

const RETIRED = new RegExp(`\\b(${Object.keys(REPLACED_BY_CHILD_CHATS).join('|')})\\b`);
const ctx = (overrides: Partial<PromptContext>): PromptContext => ({ projectName: 'demo', projectRoot: 'D:/demo', os: 'win32',
  providerFamily: 'openai', profile: 'full', ...overrides });
const CHILD_TOOLS = new Set(['create_chat', 'send_chat_message', 'read_chat', 'wait_chats', 'stop_chat', 'list_chats', 'task_list']);
const ultra = resolveUltraPreset({ enabled: true });

describe('prompts with child chats', () => {
  it('replace the subagents section with the create_chat one, and drop it without create_chat', () => {
    const on = buildSystemPrompt(ctx({ childChats: true, availableTools: CHILD_TOOLS }));
    expect(on).toContain('# Child chats (delegation)');
    expect(on).toContain('continue the same child with send_chat_message');
    expect(on).not.toMatch(RETIRED);
    const readOnlyRoot = buildSystemPrompt(ctx({ childChats: true, availableTools: new Set(['send_chat_message', 'read_chat']) }));
    expect(readOnlyRoot).not.toContain('# Child chats');
    const off = buildSystemPrompt(ctx({ availableTools: new Set(['spawn_agent']) }));
    expect(off).toContain('# Subagents (isolated delegation)');
    expect(off).not.toContain('# Child chats');
  });

  it('keep Ultra collaboration on create_chat and name the new peer tools', () => {
    const on = buildSystemPrompt(ctx({ childChats: true, multiAgentMode: 'proactive', ultraPolicy: ultra, availableTools: CHILD_TOOLS }));
    expect(on).toContain('# Ultra collaboration');
    expect(on).toContain('send_chat_message gives a child follow-up work, asks or answers (reply_to)');
    expect(on).toContain('delegate further only for separable parts');
    expect(on).not.toMatch(RETIRED);
    const noCreate = buildSystemPrompt(ctx({ childChats: true, multiAgentMode: 'proactive', ultraPolicy: ultra, availableTools: new Set(['send_chat_message']) }));
    expect(noCreate).toContain('Multi-agent mode (explicit request only)');
    const off = buildSystemPrompt(ctx({ multiAgentMode: 'proactive', ultraPolicy: ultra, availableTools: new Set(['spawn_agent', 'reply_chat_message']) }));
    expect(off).toContain('reply_chat_message answers the original request');
  });

  it('revise the shared tool texts, and leave every other tool alone', () => {
    const codeExec = withChildChatTexts({ name: 'code_exec', description: 'd', source: 'native', parameters: { type: 'object', properties: {} }, handler: async () => ({ content: '' }) });
    expect(codeExec.catalogDescription).toContain('Interactive, delegation (create_chat, send_chat_message), lifecycle');
    expect(CODE_EXEC_CATALOG_DESCRIPTION).toContain('Interactive, spawn/resume, lifecycle');
    const workflow = withChildChatTexts({ name: 'workflow', description: WORKFLOW_DESC, source: 'native', parameters: { type: 'object', properties: {} }, handler: async () => ({ content: '' }) });
    expect(workflow.description).toContain("DON'T: wrap a single task — use create_chat.");
    const recall = withChildChatTexts(recallInvestigationsTool);
    for (const text of [codeExec.catalogDescription!, workflow.description, recall.description]) expect(text).not.toMatch(RETIRED);
    expect(recallInvestigationsTool.description).toContain('spawn_agent');
    const other = { name: 'read_file', description: 'x', source: 'native' as const, parameters: { type: 'object' as const, properties: {} }, handler: async () => ({ content: '' }) };
    expect(withChildChatTexts(other)).toBe(other);
  });

  it("name create_chat in the code_exec hint and tell a child how to ask its parent", async () => {
    const message = 'ReferenceError: create_chat is not defined';
    expect(buildCodeExecFailureHint(message, { exposedNames: [], allToolNames: new Set(['create_chat']), replacedInRun: REPLACED_BY_CHILD_CHATS }))
      .toContain('e.g. task_complete, create_chat or ask_user');
    expect(buildCodeExecFailureHint(message, { exposedNames: [], allToolNames: new Set(['create_chat']) }))
      .toContain('e.g. task_complete, spawn_agent or ask_user');
    const child = (childChats: boolean) => loadChildAgentRun({ getChildAgentSession: async () => ({ id: 'c', parent_session_id: 'p', depth: 1,
      profile: 'explore', read_only: false } as never) }, 'c', undefined, { childChats });
    expect((await child(true))!.promptSection).toContain("ask it with send_chat_message (kind 'question')");
    expect((await child(false))!.promptSection).not.toContain('send_chat_message');
  });
});
