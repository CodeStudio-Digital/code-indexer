/**
 * The Explore agent is read-only: any tool that mutates the workspace, runs a
 * process or delegates work to another agent is outside the session authority,
 * not merely absent from the direct catalog. Real tool definitions are used so
 * the decision rests on their declared metadata.
 */
import { describe, expect, it } from 'vitest';
import { tmpdir } from 'node:os';
import { ToolRegistry } from '../../../registry.js';
import type { CoderTool, ToolContext } from '../../../tool.js';
import type { ChatProvider } from '../../../../providers/adapter.js';
import { CoderRunner } from '../../../runner.js';
import { buildTools, fingerprintTools, type BuildToolsArgs } from '../tools.js';
import { fsTools } from '../../../../tools/fs.js';
import { shellTools } from '../../../../tools/shell.js';
import { applyPatchTool } from '../../../../tools/apply-patch.js';
import { execCommandTools } from '../../../../tools/exec-command.js';
import { gitTools } from '../../../../tools/git.js';
import { globTools } from '../../../../tools/glob.js';
import { previewTools } from '../../../../tools/preview/index.js';
import { buildProjectMemoryTools } from '../../../../tools/project-memory-tools.js';
import { buildSessionDriveTools } from '../../../../tools/session-drive-tools.js';
import { buildConversationChapterTools } from '../../../../tools/conversation-chapters.js';
import { chatCollaborationTools } from '../../../../tools/chat-collaboration.js';
import { sessionNetworkTools } from '../../../../tools/session-network.js';
import { chatChangesTools } from '../../../../tools/chat-changes.js';
import { followupTaskTools } from '../../../../tools/followup-task.js';
import { sendMessageTools } from '../../../../tools/send-message.js';
import { sendInputTools } from '../../../../tools/send-input.js';
import { toolOutputTools } from '../../../../tools/tool-output.js';
import { buildCodeExecTool } from '../../../../tools/code-exec.js';
import { buildFindToolsTool } from '../../../../tools/find-tools.js';
import { internalMcpContract } from '../../../../tools/internal-mcp-contract.js';
import { taskComplete } from '../../../../tools/tasks.js';
import { buildCollectAgentsTool } from '../../../../tools/collect-agents.js';

const WRITE_OR_PROCESS = ['apply_patch', 'edit_file', 'write_file', 'manage_path',
  'exec_command', 'run_command', 'write_stdin', 'git_commit'];
const DELEGATION = ['spawn_agent', 'resume_agent', 'execute_tasks', 'workflow', 'integrate_chat_changes',
  'create_chat', 'create_chat_trigger', 'resume_chat', 'send_chat_message', 'followup_task', 'send_message', 'send_input'];
const READ_SURFACE = ['read_file', 'list_directory', 'glob', 'mcp__grep_code', 'mcp__search', 'code_exec', 'find_tools',
  'get_tool_output', 'ask_user', 'task_list', 'remember', 'recall_memory', 'recall_conversation',
  'mcp__get_file_skeleton', 'mcp__get_symbol_body', 'mcp__prepare_edit'];

function generic(name: string, metadata: Partial<CoderTool> = {}): CoderTool {
  return { name, source: 'native', description: `${name} operation.`, parameters: { type: 'object', properties: {} },
    handler: async () => ({ content: name }), ...metadata };
}
function registry(): ToolRegistry {
  const r = new ToolRegistry();
  r.registerAll([...fsTools, ...shellTools, applyPatchTool, ...execCommandTools, ...gitTools, ...globTools,
    ...previewTools, ...buildProjectMemoryTools(), ...buildSessionDriveTools(), ...buildConversationChapterTools(),
    ...chatCollaborationTools, ...sessionNetworkTools, ...chatChangesTools, ...followupTaskTools,
    ...sendMessageTools, ...sendInputTools, ...toolOutputTools]);
  for (const name of ['search', 'grep_code', 'get_file_skeleton', 'get_symbol_body', 'prepare_edit', 'start_agent_run']) {
    r.register(generic(`mcp__${name}`, { source: 'mcp', ...internalMcpContract(name) }));
  }
  r.registerAll(['ask_user', 'task_list', 'spawn_agent', 'resume_agent', 'invoke_skill', 'view_image'].map(name => generic(name)));
  r.registerAll([taskComplete, buildCollectAgentsTool({} as never)]);
  r.register(generic('execute_tasks', { mutates: true, riskLevel: 'write' }));
  r.register(generic('workflow', { mutates: true }));
  r.register(generic('resume_chat', { mutates: false, riskLevel: 'read', effectBoundary: 'control' }));
  r.register(buildFindToolsTool(r));
  r.register(buildCodeExecTool(r));
  return r;
}
function args(agentId: string, overrides: Partial<BuildToolsArgs> = {}): BuildToolsArgs {
  return { registry: registry(), stableCatalog: true, activeTiers: new Set(['bootstrap']),
    provider: { name: 'openai-chatgpt', model: 'gpt-6.1-sol' } as ChatProvider,
    toolContext: { cwd: tmpdir(), projectName: 'read-only', agenticChat: true,
      runner: { agentId, planMode: agentId === 'plan' } as ToolContext['runner'] }, ...overrides };
}
const names = (result: ReturnType<typeof buildTools>) => result.tools.map(t => t.name);
const authorized = (result: ReturnType<typeof buildTools>) => new Set(result.authorizedTools.map(t => t.name));

describe('read-only Explore session authority', () => {
  it.each([
    ['bootstrap', new Set(['bootstrap'])],
    ['bootstrap+preview', new Set(['bootstrap', 'preview'])],
  ])('removes write, process and delegation tools from the %s projection and authority', (_label, tiers) => {
    const explore = buildTools(args('explore', { activeTiers: tiers as BuildToolsArgs['activeTiers'] }));
    for (const name of [...WRITE_OR_PROCESS, ...DELEGATION, 'mcp__start_agent_run', 'preview_open', 'preview_click', 'preview_fill']) {
      expect(names(explore), name).not.toContain(name);
      expect(authorized(explore).has(name), name).toBe(false);
    }
    expect(names(explore)).toEqual(expect.arrayContaining([...READ_SURFACE, 'git_status', 'git_diff']));
    for (const name of ['save_note', 'reply_chat_message', 'list_sessions', 'read_chat_changes']) {
      expect(authorized(explore).has(name), name).toBe(true);
    }
    const build = buildTools(args('build', { activeTiers: tiers as BuildToolsArgs['activeTiers'] }));
    expect(fingerprintTools(explore.tools)).not.toBe(fingerprintTools(build.tools));
  });

  it('drops continuation controls whose opener is outside the read-only authority', () => {
    const explore = buildTools(args('explore'));
    for (const name of ['task_complete', 'collect_agents']) {
      expect(names(explore), name).not.toContain(name);
      expect(authorized(explore).has(name), name).toBe(false);
    }
    const build = buildTools(args('build', { activeTiers: new Set(['bootstrap', 'navigate']) }));
    expect(names(build)).toEqual(expect.arrayContaining(['task_complete', 'execute_tasks', 'collect_agents']));
  });

  it.each([[{ mutates: false, riskLevel: 'read' }, true], [{ mutates: true, riskLevel: 'write' }, false]] as const)(
    'decides continuations by declared metadata, not by name (opener %o kept=%s)', (opener, kept) => {
      const input = args('explore');
      input.registry.registerAll([generic('probe_open', opener), generic('probe_finish', { continues: ['probe_open'] })]);
      expect(authorized(buildTools(input)).has('probe_finish')).toBe(kept);
    });

  it('keeps observation of an already open preview in Explore', () => {
    const explore = buildTools(args('explore', { activeTiers: new Set(['bootstrap', 'preview']) }));
    expect(names(explore)).toEqual(expect.arrayContaining(['preview_snapshot', 'preview_screenshot', 'preview_console']));
  });

  it('leaves Build and Plan authority unchanged', () => {
    for (const agentId of ['build', 'plan']) {
      const result = buildTools(args(agentId, { activeTiers: new Set(['bootstrap', 'navigate']) }));
      for (const name of [...WRITE_OR_PROCESS, 'spawn_agent', 'execute_tasks', 'create_chat']) {
        expect(authorized(result).has(name), `${agentId}:${name}`).toBe(true);
      }
      expect(names(result)).toEqual(expect.arrayContaining(['apply_patch', 'edit_file', 'exec_command', 'write_stdin']));
    }
  });

  it('reports denied tools as blocked in discovery', async () => {
    const input = args('explore');
    const explore = buildTools(input);
    const runnerState = { authorizedToolNames: authorized(explore), visibleToolNames: new Set(names(explore)),
      opts: { toolContext: input.toolContext } };
    const discoveryState = (name: string) => CoderRunner.prototype.discoveryState.call(runnerState as never, name);
    expect(discoveryState('apply_patch').authorization).toBe('blocked');
    expect(discoveryState('run_command').authorization).toBe('blocked');
    expect(discoveryState('read_file').authorization).toBe('requires_dispatch_validation');
    const found = await input.registry.get('find_tools')!.handler({ query: 'apply_patch', limit: 1 }, {
      ...input.toolContext, runner: { stableToolCatalog: true, visibleToolNames: runnerState.visibleToolNames, discoveryState },
    } as never);
    expect(found.content).toContain('blocked by session configuration');
    expect(found.structuredData).toMatchObject({ candidates: [{ name: 'apply_patch', authorization: 'blocked' }] });
  });
});
