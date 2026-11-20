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
  Object.assign(ctx.opts, { sessionDisabledTools: disabled });
  const execute = new ExecutingNode();
  await execute.execute(ctx, null);
  // A discovery between turns (find_tools) publishes nothing new.
  await execute.execute(ctx, null);
  expect(requests[1].tools).toEqual(requests[0].tools);
  expect(requests[0].tools?.map(tool => tool.name)).toEqual(expect.arrayContaining(['exec_command', 'write_stdin', 'get_tool_output']));
  disabled.add('exec_command');
  await execute.execute(ctx, null);
  expect(requests[2].tools?.some(tool => tool.name === 'exec_command')).toBe(false);
});
