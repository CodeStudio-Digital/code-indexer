/**
 * Read-only sessions refuse write/process tools at every dispatch boundary:
 * direct top-level calls, nested code_exec calls through the runner preflight,
 * and the standalone code_exec evaluator. Handlers never run.
 */
import { describe, expect, it, vi } from 'vitest';
import type { ChatProvider, ChatRequest } from '../../../../providers/adapter.js';
import { ToolRegistry } from '../../../registry.js';
import type { CoderTool, ToolContext } from '../../../tool.js';
import { evaluateToolInvocation } from '../../../policy.js';
import { buildCodeExecTool } from '../../../../tools/code-exec.js';
import { ExecutingNode } from '../executing.js';
import { makeTestContext } from './test-helpers.js';

const NESTED_WRITE = `try { await tools.apply_patch({ input: 'x' }); return 'wrote'; }
catch (e) { return 'refused: ' + String(e && e.message ? e.message : e); }`;

function fixture() {
  const registry = new ToolRegistry();
  const write = vi.fn(async () => ({ content: 'patched' }));
  const run = vi.fn(async () => ({ content: 'ran' }));
  const tool = (name: string, extra: Partial<CoderTool> = {}): CoderTool => ({ name, source: 'native',
    description: `${name} operation`, parameters: { type: 'object', properties: {} },
    handler: async () => ({ content: `${name}-ok` }), ...extra });
  registry.registerAll([tool('read_file'), tool('find_tools'), tool('apply_patch', { handler: write }),
    tool('exec_command', { mutates: true, riskLevel: 'execute', handler: run }), tool('write_stdin', { mutates: true, riskLevel: 'execute' })]);
  registry.register(buildCodeExecTool(registry));
  return { registry, write, run };
}

function resultText(messages: ReturnType<typeof makeTestContext>['ctx']['messages'], id: string): string {
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === 'tool_result' && block.tool_use_id === id) {
        return typeof block.content === 'string' ? block.content : JSON.stringify(block.content);
      }
    }
  }
  throw new Error(`no tool_result for ${id}`);
}

describe('read-only session dispatch', () => {
  it('refuses direct and nested write calls in Explore, then restores authority after a live switch', async () => {
    const { registry, write, run } = fixture();
    const requests: ChatRequest[] = [];
    const provider: ChatProvider = { name: 'anthropic', model: 'claude-sonnet-4-5', setModel() {}, async *chat(request) {
      requests.push(request);
      if (requests.length > 1) {
        yield { type: 'text_delta', text: 'done' };
        yield { type: 'done', stop_reason: 'end_turn' };
        return;
      }
      const calls: Array<[string, string, Record<string, unknown>]> = [
        ['direct-write', 'apply_patch', { input: 'x' }],
        ['direct-run', 'exec_command', { cmd: 'ls' }],
        ['nested-write', 'code_exec', { code: NESTED_WRITE }],
        ['nested-read', 'code_exec', { code: `return await tools.read_file({ path: 'a.ts' });` }],
      ];
      for (const [id, name, input] of calls) {
        yield { type: 'tool_call_start', id, name };
        yield { type: 'tool_call_end', id, name, input };
      }
      yield { type: 'done', stop_reason: 'tool_use' };
    } };
    const runner = { agentId: 'explore', planMode: false };
    const { ctx } = makeTestContext({ provider, registry, toolContext: { cwd: process.cwd(), projectName: 'read-only',
      runner: runner as unknown as ToolContext['runner'] } as ToolContext });
    const execute = new ExecutingNode();
    await execute.execute(ctx, null);

    expect(requests[0].tools?.map(t => t.name)).not.toContain('apply_patch');
    expect(write).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    expect(resultText(ctx.messages, 'direct-write')).toContain('read-only');
    expect(resultText(ctx.messages, 'direct-run')).toContain('read-only');
    expect(resultText(ctx.messages, 'nested-write')).toContain('refused');
    expect(resultText(ctx.messages, 'nested-write')).toContain('read-only');
    expect(resultText(ctx.messages, 'nested-read')).toContain('read_file-ok');

    runner.agentId = 'build';
    await execute.execute(ctx, null);
    expect(requests[1].tools?.map(t => t.name)).toEqual(expect.arrayContaining(['apply_patch', 'exec_command']));
  });

  it('refuses a nested write in the standalone code_exec evaluator', async () => {
    const { registry, write } = fixture();
    const result = await registry.get('code_exec')!.handler({ code: NESTED_WRITE }, {
      cwd: process.cwd(), projectName: 'read-only',
      runner: { agentId: 'explore', opts: { planMode: false }, isPlanApproved: () => false,
        currentTaskScopeId: () => null, currentTaskScopeFiles: () => null } as unknown as ToolContext['runner'],
    });
    expect(write).not.toHaveBeenCalled();
    expect(String(result.content)).toContain('refused');
    expect(String(result.content)).toContain('read-only');
  });

  it('classifies invocations through the single read-only predicate', () => {
    const ctx = { planMode: false, planApproved: false, taskScope: null, readOnly: true };
    const tool = (name: string, extra: Partial<CoderTool> = {}): CoderTool => ({ name, source: 'native',
      description: name, parameters: { type: 'object', properties: {} }, handler: async () => ({ content: '' }), ...extra });
    expect(evaluateToolInvocation(tool('apply_patch'), {}, ctx)).toMatchObject({ allowed: false, reason: 'read_only' });
    expect(evaluateToolInvocation(tool('run_command'), {}, ctx)).toMatchObject({ allowed: false, reason: 'read_only' });
    expect(evaluateToolInvocation(tool('create_chat', { riskLevel: 'read', mutates: false }), {}, ctx))
      .toMatchObject({ allowed: false, reason: 'read_only' });
    expect(evaluateToolInvocation(tool('ext_lookup', { source: 'mcp_external' }), {}, ctx)).toMatchObject({ allowed: false });
    for (const allowed of [tool('read_file'), tool('code_exec'), tool('ask_user'),
      tool('remember', { mutates: true, riskLevel: 'write' }), tool('save_note', { mutates: true, riskLevel: 'write' })]) {
      expect(evaluateToolInvocation(allowed, {}, ctx).allowed, allowed.name).toBe(true);
    }
    expect(evaluateToolInvocation(tool('apply_patch'), {}, { ...ctx, readOnly: false }).allowed).toBe(true);
  });
});
