import { describe, expect, it } from 'vitest';
import { tmpdir } from 'node:os';
import { ToolRegistry } from '../../../registry.js';
import type { CoderTool, ToolContext } from '../../../tool.js';
import type { ChatProvider } from '../../../../providers/adapter.js';
import { buildTools, fingerprintTools, type BuildToolsArgs } from '../tools.js';
import { buildCodeExecTool } from '../../../../tools/code-exec.js';
import { API_TOOLS, BROWSER_TOOLS, DB_TOOLS, DIAGRAM_TOOLS, QA_TOOLS } from '../../../../tools/tiers.js';
import { PREVIEW_WORKFLOW_FLOOR } from '../../../../tools/tool-priority.js';
import { isEssentialCompanyTool } from '../../company-essentials.js';

const NAMES = [
  'code_exec', 'find_tools', 'capability_catalog', 'expand_toolset',
  'read_file', 'mcp__read_file', 'glob', 'mcp__grep_code', 'mcp__search',
  'list_directory', 'mcp__list_directory', 'apply_patch', 'edit_file', 'write_file', 'create_file',
  'run_command', 'exec_command', 'write_stdin', 'list_sessions', 'get_tool_output',
  'ask_user', 'decision_gate', 'task_list', 'submit_tasks', 'submit_plan', 'submit_spec',
  'remember', 'recall_memory', 'recall_conversation', 'spawn_agent', 'resume_agent', 'collect_agents',
  'task_complete', 'execute_tasks', 'view_image', 'view_video',
  'mcp__get_file_skeleton', 'mcp__get_symbol_body', 'mcp__prepare_edit', 'git_status', 'git_diff',
];
const CORE = ['read_file', 'glob', 'mcp__grep_code', 'mcp__search', 'list_directory',
  'apply_patch', 'edit_file', 'exec_command', 'write_stdin', 'get_tool_output', 'find_tools', 'code_exec'];
function tool(name: string, overrides: Partial<CoderTool> = {}): CoderTool {
  return { name, source: 'native', description: `${name}. Keep its complete operational contract.`,
    parameters: { type: 'object', properties: {} }, handler: async () => ({ content: name }), ...overrides };
}
function args(overrides: Partial<BuildToolsArgs> = {}): BuildToolsArgs {
  const registry = new ToolRegistry();
  registry.registerAll([...NAMES, ...Array.from({ length: 200 }, (_, i) => `cold_${i}`)].map(name => tool(name)));
  return { registry, stableCatalog: true, activeTiers: new Set(['bootstrap', 'navigate']),
    provider: { name: 'openai-chatgpt', model: 'gpt-6.1-sol' } as ChatProvider,
    toolContext: { cwd: tmpdir(), projectName: 'catalog' }, ...overrides };
}
const names = (result: ReturnType<typeof buildTools>) => result.tools.map(t => t.name);

describe('workflow catalog', () => {
  it.each([
    ['openai-chatgpt', 'gpt-6.1-sol'], ['openai', 'gpt-5.4'], ['anthropic', 'claude-sonnet-4-5'],
    ['gemini', 'gemini-2.5-pro'], ['kimi-code', 'kimi-k2.5'], ['zai', 'glm-4.5-flash'], ['openrouter', 'unknown/model'],
  ])('keeps a complete coding workflow for %s without filling it with cold tools', (name, model) => {
    const result = buildTools(args({ provider: { name, model } as ChatProvider }));
    expect(names(result)).toEqual(expect.arrayContaining(CORE));
    expect(result.tools.length).toBeLessThanOrEqual(28);
    for (const n of CORE) expect(result.protectedToolNames.has(n), n).toBe(true);
    expect(names(result)).not.toContain('run_command');
    expect(names(result)).not.toContain('write_file');
    expect(names(result)).not.toContain('capability_catalog');
    expect(names(result).some(n => n.startsWith('cold_'))).toBe(false);
    expect(result.authorizedTools.some(t => t.name === 'run_command')).toBe(true);
    expect(names(result)).toEqual([...names(result)].sort((a, b) => a.localeCompare(b)));
  });

  it('does not change the catalog when tools are discovered or registry order changes', () => {
    const input = args();
    const before = buildTools(input);
    const reversed = new ToolRegistry();
    reversed.registerAll([...input.registry.list()].reverse());
    const after = buildTools({ ...input, registry: reversed, pinnedTools: new Set(['cold_1', 'cold_2', 'run_command']) });
    expect(fingerprintTools(after.tools)).toBe(fingerprintTools(before.tools));
  });

  it('keeps ordinary chat creation and peer messaging directly visible in Agêntico mode', () => {
    const input = args();
    const collaboration = ['create_chat', 'send_chat_message', 'reply_chat_message'];
    input.registry.registerAll(collaboration.map(name => tool(name)));
    const standard = buildTools(input);
    expect(names(standard)).not.toContain('create_chat');
    expect(standard.tools.find(tool => tool.name === 'spawn_agent')?.description).toContain('temporary subagents');
    const agentic = { ...input, toolContext: { ...input.toolContext, agenticChat: true } };
    const result = buildTools(agentic);
    for (const name of collaboration) expect(result.protectedToolNames.has(name)).toBe(true);
    expect(names(buildTools({ ...agentic, sessionDisabledTools: new Set(['create_chat']) }))).not.toContain('create_chat');
  });

  it('keeps lifecycle pairs and only the gates of the active mode', () => {
    const build = buildTools(args());
    expect(names(build)).toEqual(expect.arrayContaining(['spawn_agent', 'resume_agent', 'collect_agents', 'execute_tasks', 'task_complete']));
    for (const name of ['submit_tasks', 'submit_spec', 'submit_plan', 'decision_gate', 'expand_toolset']) {
      expect(names(build)).not.toContain(name);
    }
    expect(build.authorizedTools.map(t => t.name)).not.toContain('submit_tasks');
    const plan = buildTools(args({ toolContext: { cwd: tmpdir(), runner: { planMode: true } } as ToolContext }));
    expect(names(plan)).toEqual(expect.arrayContaining(['submit_plan', 'decision_gate', 'task_list']));
    expect(names(plan)).not.toContain('submit_tasks');
    expect(plan.tools.find(t => t.name === 'task_list')?.parameters).not.toEqual(build.tools.find(t => t.name === 'task_list')?.parameters);
    const spec = buildTools(args({ toolContext: { cwd: tmpdir(), runner: { planMode: true, specMode: true } } as ToolContext }));
    expect(names(spec)).toContain('submit_spec');
    expect(names(spec)).not.toContain('submit_plan');
  });

  it('keeps the review tool visible in Build when there is an approved plan to revise', () => {
    const toolContext: ToolContext = {
      cwd: tmpdir(), projectName: 'catalog',
      runner: { agentId: 'build', planMode: false } as ToolContext['runner'],
      getActivePlan: () => ({ text: 'Approved plan', status: 'approved' }),
      setSessionAgent: () => undefined,
    };
    const build = buildTools(args({ toolContext }));
    expect(build.protectedToolNames.has('submit_plan')).toBe(true);
    expect(names(build)).not.toContain('decision_gate');
    expect(names(buildTools(args({ toolContext, sessionDisabledTools: new Set(['submit_plan']) })))).not.toContain('submit_plan');
  });

  it('applies revocation before selecting canonical alternatives and ignores pins for disabled tools', () => {
    const result = buildTools(args({ sessionDisabledTools: new Set(['read_file', 'exec_command', 'apply_patch']),
      requiredPinnedTools: new Set(['read_file', 'exec_command', 'apply_patch']) }));
    expect(names(result)).toEqual(expect.arrayContaining(['mcp__read_file', 'run_command', 'write_stdin', 'create_file', 'write_file']));
    for (const name of ['read_file', 'exec_command', 'apply_patch']) {
      expect(names(result)).not.toContain(name);
      expect(result.authorizedTools.some(t => t.name === name)).toBe(false);
    }
  });

  it('preserves explicit host pins, and fails honestly when the verified hard limit cannot fit the workflow', () => {
    const result = buildTools(args({ sessionToolCap: 5, requiredPinnedTools: new Set(['cold_99']) }));
    expect(names(result)).toEqual(expect.arrayContaining([...CORE, 'cold_99']));
    expect(() => buildTools(args({ provider: { name: 'custom', model: 'custom', toolLimits: { maxCount: 5 } } as ChatProvider })))
      .toThrow(/cannot fit required capabilities/);
  });

  it.each([
    ['api', API_TOOLS], ['browser', BROWSER_TOOLS], ['db', DB_TOOLS],
    ['diagram', DIAGRAM_TOOLS], ['qa', QA_TOOLS], ['preview', PREVIEW_WORKFLOW_FLOOR],
  ])('keeps the %s role complete without exposing it to unrelated sessions', (tier, roleTools) => {
    const input = args();
    input.registry.registerAll([...roleTools].map(name => tool(name)));
    const inactive = buildTools(input);
    for (const name of roleTools) expect(names(inactive)).not.toContain(name);
    const active = buildTools({ ...input, activeTiers: new Set(['bootstrap', 'navigate', tier]) });
    expect(names(active)).toEqual(expect.arrayContaining([...CORE, ...roleTools]));
  });

  it.each([true, false])('preserves Company communication and orchestration (master=%s)', isMaster => {
    const input = args();
    const companyNames = ['post_to_board', 'read_board', 'write_shared_file', 'read_shared_file', 'list_shared_files',
      'spawn_subordinate_agent', 'forward_to_agent', 'resume_subordinate', 'list_subordinates', 'list_company_projects',
      'wait_for_subordinates', 'abort_subordinate_agent', 'finalize_subordinates', 'approve_subordinate_plan',
      'approve_subordinate_tasks', 'answer_subordinate_question', 'respond_to_inbox', 'kanban_plan_graph',
      'kanban_list_cards', 'kanban_move_card', 'set_agent_status', 'ask_master', 'submit_plan_to_master', 'submit_tasks_to_master'];
    const expected = companyNames.filter(n => isEssentialCompanyTool(n, isMaster));
    input.registry.registerAll(expected.map(n => tool(n)));
    const result = buildTools({ ...input, toolContext: { ...input.toolContext, companyContext: { isMaster } } as ToolContext });
    expect(names(result)).toEqual(expect.arrayContaining(expected));
  });

  it('keeps plugin interaction controls direct and preserves their full or authored contracts', () => {
    const input = args();
    const description = `Connect the service. ${'Read carefully. '.repeat(40)}Only continue after a verified callback.`;
    input.registry.register(tool('plugin_connect', { source: 'mcp_external', interactive: true, description }));
    const projected = buildTools(input).tools.find(t => t.name === 'plugin_connect');
    expect(projected?.description).toBe(description);
    input.registry.register(tool('plugin_contract', { source: 'mcp_external', interactive: true, description,
      catalogDescription: 'A deliberately authored compact contract.' }));
    expect(buildTools(input).tools.find(t => t.name === 'plugin_contract')?.description).toBe('A deliberately authored compact contract.');
  });

  it('does not defer active tools into a missing code_exec bridge', () => {
    const input = args({ sessionDisabledTools: new Set(['code_exec']) });
    expect(names(buildTools(input))).toContain('cold_99');
  });

  it('retains an executable batching recipe and the safety/output contract under small caps', async () => {
    const registry = new ToolRegistry();
    const reads: string[] = [];
    registry.register(tool('read_file', { mutates: false, parallelSafe: true,
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      handler: async input => { reads.push(String(input.path)); return { content: String(input.path) }; } }));
    registry.register(buildCodeExecTool(registry));
    const result = buildTools(args({ registry, sessionToolCap: 8 }));
    const description = result.tools.find(t => t.name === 'code_exec')!.description;
    expect(description).toContain('Promise.all');
    expect(description).toContain('Await every promise');
    expect(description).toContain('permission');
    expect(description).toContain('Never replay');
    const example = description.split('\n').find(line => line.startsWith('Example: '))!.slice('Example: '.length);
    const output = await registry.get('code_exec')!.handler({ code: example }, { cwd: tmpdir(), projectName: 'batch-contract' });
    expect(output.isError).not.toBe(true);
    expect(reads.sort()).toEqual(['src/a.ts', 'src/b.ts']);
    expect(JSON.stringify(output.content)).toContain('src/b.ts');
  });
});
