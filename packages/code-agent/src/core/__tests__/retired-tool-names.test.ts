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
import { RETIRED_TOOL_REPLACEMENTS, retiredToolInstruction } from '../tool-name-suggest.js';
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
};

describe('retired tool map', () => {
  it('names exactly the six retired tools and their replacements', () => {
    expect(Object.keys(RETIRED_TOOL_REPLACEMENTS).sort())
      .toEqual(['create_file', 'multi_edit', 'poll_session', 'submit_tasks', 'todo_write', 'update_todo']);
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
