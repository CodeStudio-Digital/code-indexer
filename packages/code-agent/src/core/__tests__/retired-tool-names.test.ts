/**
 * Retired tool names fail with an instruction, never as silent aliases:
 * multi_edit → edit_file with edits; create_file → write_file;
 * todo_write / update_todo / submit_tasks → task_list; poll_session →
 * write_stdin with empty chars. Covered at the
 * top-level registry dispatch and for nested code_exec calls (both the
 * `tools.<name>` proxy and the bare global).
 */
import { describe, expect, it, vi } from 'vitest';
import { ok, type CoderTool, type ToolContext } from '@mcp/code-agent/core/tool.js';
import { ToolRegistry } from '../registry.js';
import { RETIRED_TOOL_REPLACEMENTS, retiredToolInstruction, toolReplacement } from '../tool-name-suggest.js';
import { buildCodeExecTool } from '../../tools/code-exec.js';
import { buildCodeExecFailureHint } from '../../tools/code-exec-hints.js';

const ctx = (): ToolContext => ({ cwd: process.cwd(), projectName: 'retired-tools' });

function spyTool(name: string): { tool: CoderTool; handler: ReturnType<typeof vi.fn> } {
  const handler = vi.fn(async () => ok(`${name}-ok`));
  return {
    handler,
    tool: {
      name, description: 'spy', source: 'native', mutates: true,
      parameters: { type: 'object', properties: {}, additionalProperties: true }, handler,
    },
  };
}

function registryWithReplacements() {
  const registry = new ToolRegistry();
  const spies = ['edit_file', 'write_file', 'task_list', 'write_stdin'].map(spyTool);
  for (const s of spies) registry.register(s.tool);
  return { registry, spies };
}

const EXPECTED: Record<string, RegExp> = {
  multi_edit: /edit_file with `edits: \[/,
  create_file: /write_file/,
  todo_write: /task_list.*`items`/,
  update_todo: /task_list.*`updates`/,
  submit_tasks: /task_list.*gate:'approve'/,
  poll_session: /write_stdin .*empty/,
  expand_toolset: /find_tools.*code_exec/,
  capability_catalog: /find_tools.*get_skills_list and get_skill_content/,
  mcp__index_project: /application\/CLI action.*mcp__get_project_overview/,
  mcp__export_docs: /application\/CLI action.*mcp__get_repo_map/,
  mcp_list_resources: /no longer publishes MCP resources.*mcp__get_project_overview and mcp__get_repo_map/,
  mcp_read_resource: /no longer publishes MCP resources.*mcp__get_project_overview and mcp__get_repo_map/,
  mcp__list_agents: /agent-run API was removed together with the MCP server; there is no replacement tool\.$/,
  mcp__list_agent_runs: /agent-run API was removed together with the MCP server; there is no replacement tool\.$/,
  mcp__get_agent_run: /agent-run API was removed together with the MCP server; there is no replacement tool\.$/,
  mcp__get_agent_result: /agent-run API was removed together with the MCP server; there is no replacement tool\.$/,
};
const AGENT_RUN_READS = ['list_agents', 'list_agent_runs', 'get_agent_run', 'get_agent_result'];
const AGENT_RUN_TEXT = 'The agent-run API was removed together with the MCP server; there is no replacement tool.';

describe('retired tool map', () => {
  it('names exactly the sixteen retired tools and their replacements', () => {
    expect(Object.keys(RETIRED_TOOL_REPLACEMENTS).sort())
      .toEqual(['capability_catalog', 'create_file', 'expand_toolset', 'mcp__export_docs', 'mcp__get_agent_result',
        'mcp__get_agent_run', 'mcp__index_project', 'mcp__list_agent_runs', 'mcp__list_agents', 'mcp_list_resources',
        'mcp_read_resource', 'multi_edit', 'poll_session', 'submit_tasks', 'todo_write', 'update_todo']);
    expect(retiredToolInstruction('edit_file')).toBeNull();
    for (const [name, pattern] of Object.entries(EXPECTED)) {
      expect(retiredToolInstruction(name)).toMatch(new RegExp(`^${name} was retired\\.`));
      expect(retiredToolInstruction(name)).toMatch(pattern);
    }
  });
});

describe('top-level dispatch of a retired name', () => {
  it.each(Object.keys(EXPECTED))('%s fails with the instruction and runs nothing', async (name) => {
    const { registry, spies } = registryWithReplacements();
    const res = await registry.invoke(name, { path: 'a.ts' }, ctx());
    expect(res.isError).toBe(true);
    expect(res.content).toBe(retiredToolInstruction(name));
    expect(res.error).toMatchObject({ code: 'RETIRED_TOOL', kind: 'invalid_input', retryable: false });
    for (const s of spies) expect(s.handler).not.toHaveBeenCalled();
  });

  it('keeps the plain unknown-tool error for names that were never tools', async () => {
    const { registry } = registryWithReplacements();
    const res = await registry.invoke('no_such_tool', {}, ctx());
    expect(res.content).toMatch(/^Unknown tool: no_such_tool\./);
  });
});

describe('nested code_exec call of a retired name', () => {
  it('tools.multi_edit throws the instruction instead of reaching edit_file', async () => {
    const { registry, spies } = registryWithReplacements();
    const res = await buildCodeExecTool(registry).handler(
      { code: "await tools.multi_edit({ path: 'a.ts', edits: [] }); return 'unreachable';" }, ctx());
    expect(res.isError).toBe(true);
    expect(res.content).toContain(retiredToolInstruction('multi_edit')!);
    expect(res.content).not.toContain('unreachable');
    for (const s of spies) expect(s.handler).not.toHaveBeenCalled();
  });

  it('a bare create_file() rejects with the instruction and leaves write_file untouched', async () => {
    const { registry, spies } = registryWithReplacements();
    const res = await buildCodeExecTool(registry).handler(
      { code: "await create_file({ path: 'n.ts', content: 'x' }); return 'unreachable';" }, ctx());
    expect(res.isError).toBe(true);
    expect(res.content).toContain(`create_file: ${retiredToolInstruction('create_file')}`);
    expect(res.content).not.toContain('is not defined'); // the global itself carries the instruction
    for (const s of spies) expect(s.handler).not.toHaveBeenCalled();
  });

  it('the failure hint names the replacement when the bare name surfaces as a ReferenceError', () => {
    const hint = buildCodeExecFailureHint('ReferenceError: todo_write is not defined', {
      exposedNames: ['task_list'], allToolNames: new Set(['task_list']),
    });
    expect(hint).toContain(retiredToolInstruction('todo_write')!);
  });

  it.each(Object.keys(EXPECTED))('tool_schema(%s) returns the retirement instruction, not a generic unknown', async (name) => {
    const { registry } = registryWithReplacements();
    const res = await buildCodeExecTool(registry).handler(
      { code: `return JSON.stringify(tool_schema(${JSON.stringify(name)}));` }, ctx());
    expect(res.isError).toBe(true);
    expect(res.content).toContain(`tool_schema: ${retiredToolInstruction(name)}`);
    expect(res.content).not.toContain('unknown tool');
  });
});

describe('retired index tools in the per-project form', () => {
  it('answers the primary form', () => {
    expect(toolReplacement('mcp__index_project')).toEqual({ code: 'RETIRED_TOOL', text: retiredToolInstruction('mcp__index_project') });
    expect(retiredToolInstruction('mcp__export_docs')!.startsWith('mcp__export_docs was retired. Documentation export is an application/CLI action')).toBe(true);
  });

  it('answers the prefixed form, pointing at the same project tools (the slug may contain _)', () => {
    const exportDocs = toolReplacement('mcp__parity_second__export_docs');
    expect(exportDocs?.code).toBe('RETIRED_TOOL');
    expect(exportDocs!.text.startsWith('mcp__parity_second__export_docs was retired. Documentation export is an application/CLI action')).toBe(true);
    expect(exportDocs?.text).toContain('mcp__parity_second__get_project_overview and mcp__parity_second__get_repo_map');
    expect(exportDocs?.text).not.toMatch(/(^|[^_])mcp__get_/);
    const index = toolReplacement('mcp__my_app__v2__index_project');
    expect(index?.code).toBe('RETIRED_TOOL');
    expect(index!.text.startsWith('mcp__my_app__v2__index_project was retired. Indexing is an application/CLI action')).toBe(true);
    expect(index?.text).toContain('mcp__my_app__v2__get_project_overview');
  });

  it('leaves prefixed tools that were not retired unanswered', () => {
    for (const name of ['mcp__parity_second__grep_code', 'mcp__parity_second__read_file', 'mcp__parity_second__index_projects', 'ext_server__index_project']) {
      expect(toolReplacement(name), name).toBeNull();
    }
  });

  it('refuses a prefixed retired call at the registry without dispatching', async () => {
    const { registry, spies } = registryWithReplacements();
    const res = await registry.invoke('mcp__parity_second__index_project', {}, ctx());
    expect(res.isError).toBe(true);
    expect(res.content).toBe(retiredToolInstruction('mcp__parity_second__index_project'));
    expect(res.error).toMatchObject({ code: 'RETIRED_TOOL', kind: 'invalid_input', retryable: false });
    for (const s of spies) expect(s.handler).not.toHaveBeenCalled();
  });
});

describe('retired agent-run reads', () => {
  it('answer the primary and the prefixed form with the same text, which names no other tool', () => {
    for (const name of AGENT_RUN_READS.flatMap(n => [`mcp__${n}`, `mcp__parity_second__${n}`, `mcp__my_app__v2__${n}`])) {
      expect(toolReplacement(name), name).toEqual({ code: 'RETIRED_TOOL', text: `${name} was retired. ${AGENT_RUN_TEXT}` });
    }
    expect(AGENT_RUN_TEXT).not.toMatch(/[a-z]+_[a-z_]+/); // no tool name: list_agents and the delegation tools vary by session
  });

  it('leave the never-registered control verbs to the plain unknown-tool error', async () => {
    for (const name of ['mcp__start_agent_run', 'mcp__cancel_agent_run', 'mcp__parity_second__start_agent_run', 'list_agents']) {
      expect(toolReplacement(name), name).toBeNull();
    }
    const { registry } = registryWithReplacements();
    expect((await registry.invoke('mcp__start_agent_run', {}, ctx())).content).toMatch(/^Unknown tool: mcp__start_agent_run\./);
  });
});
