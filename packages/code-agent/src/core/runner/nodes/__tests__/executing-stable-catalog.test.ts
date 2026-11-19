import { expect, it, vi } from 'vitest';
import type { ChatProvider, ChatRequest } from '../../../../providers/adapter.js';
import { ToolRegistry } from '../../../registry.js';
import type { ToolContext } from '../../../tool.js';
import { ExecutingNode } from '../executing.js';
import { makeTestContext } from './test-helpers.js';

it.each([
  ['openai-chatgpt', 'gpt-6.1-sol'], ['openai', 'gpt-5.4'],
  ['anthropic', 'claude-sonnet-4-5'], ['gemini', 'gemini-2.5-pro'], ['kimi-code', 'kimi-k2.5'],
])('keeps %s projection stable across turns and discoveries while honoring revocation', async (name, model) => {
  const registry = new ToolRegistry();
  for (const toolName of ['read_file', 'code_exec', 'find_tools', 'get_tool_output', 'exec_command', 'write_stdin', 'list_sessions', 'cold_tool']) {
    registry.register({ name: toolName, source: 'native', description: `${toolName} operation`, parameters: { type: 'object', properties: {} }, handler: async () => ({ content: 'ok' }) });
  }
  const requests: ChatRequest[] = [];
  const provider: ChatProvider = { name, model, setModel() {}, async *chat(request) {
    requests.push(request);
    yield { type: 'text_delta', text: 'done' };
    yield { type: 'done', stop_reason: 'stop' };
  } };
  const { ctx } = makeTestContext({ provider, registry, toolContext: { cwd: process.cwd(), projectName: 'stable' } as ToolContext });
  const disabled = new Set<string>();
  const selector = vi.fn(async (tools: ChatRequest['tools']) => tools);
  Object.assign(ctx.opts, { sessionDisabledTools: disabled, toolSelectionFilter: selector });
  const execute = new ExecutingNode();
  await execute.execute(ctx, null);
  ctx.pinnedTools.add('cold_tool');
  await execute.execute(ctx, null);
  expect(requests[1].tools).toEqual(requests[0].tools);
  expect(selector).toHaveBeenCalledTimes(1);
  expect(requests[0].tools?.map(tool => tool.name)).toEqual(expect.arrayContaining(['exec_command', 'write_stdin', 'get_tool_output']));
  disabled.add('exec_command');
  await execute.execute(ctx, null);
  expect(requests[2].tools?.some(tool => tool.name === 'exec_command')).toBe(false);
  expect(selector).toHaveBeenCalledTimes(2);
});

it('does not let a relevance filter erase the workflow or inject an unprojected tool', async () => {
  const registry = new ToolRegistry();
  for (const name of ['read_file', 'code_exec', 'find_tools', 'exec_command', 'write_stdin', 'mcp__grep_code']) {
    registry.register({ name, source: 'native', description: name, parameters: { type: 'object', properties: {} }, handler: async () => ({ content: 'ok' }) });
  }
  const requests: ChatRequest[] = [];
  const provider: ChatProvider = { name: 'anthropic', model: 'claude-sonnet-4-5', setModel() {}, async *chat(request) {
    requests.push(request); yield { type: 'text_delta', text: 'done' }; yield { type: 'done', stop_reason: 'stop' };
  } };
  const { ctx } = makeTestContext({ provider, registry, toolContext: { cwd: process.cwd(), projectName: 'stable' } as ToolContext });
  ctx.opts.toolSelectionFilter = async () => [{ name: 'injected', description: 'not authorized', parameters: { type: 'object', properties: {} } }];
  await new ExecutingNode().execute(ctx, null);
  expect(requests[0].tools?.map(t => t.name)).toEqual(expect.arrayContaining(['read_file', 'mcp__grep_code', 'exec_command', 'write_stdin']));
  expect(requests[0].tools?.some(t => t.name === 'injected')).toBe(false);
});
