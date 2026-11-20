/**
 * A tool's sub-runner usage (spawn_agent, a waited-for child agent) and the
 * run keys it covers reach the `tool_call_result` event, which runCoder adds
 * to the turn's subagent usage and persists with the turn metric.
 */
import { describe, expect, it } from 'vitest';
import type { ChatDelta } from '@mcp/code-agent/core/messages.js';
import type { ChatProvider } from '@mcp/code-agent/providers/adapter.js';
import type { CoderTool, ToolContext, ToolResult } from '@mcp/code-agent/core/tool.js';
import { ToolRegistry } from '@mcp/code-agent/core/registry.js';
import { ExecutingNode } from '../executing.js';
import { makeTestContext } from './test-helpers.js';

function provider(deltas: ChatDelta[]): ChatProvider {
  return { name: 'mock', model: 'claude-haiku-4-5-20251001', setModel() {}, async *chat() { for (const delta of deltas) yield delta; } };
}

function registryWith(result: ToolResult): ToolRegistry {
  const registry = new ToolRegistry();
  const tool: CoderTool = { name: 'wait_child', description: 'mock', parameters: { type: 'object', properties: {} }, source: 'native',
    handler: async () => result };
  registry.register(tool);
  return registry;
}

async function emitted(result: ToolResult) {
  const { ctx, recordedEvents } = makeTestContext({
    provider: provider([
      { type: 'tool_call_start', id: 'tu1', name: 'wait_child' },
      { type: 'tool_call_end', id: 'tu1', name: 'wait_child', input: {} },
      { type: 'done', stop_reason: 'tool_use' },
    ]),
    registry: registryWith(result),
    toolContext: { cwd: process.cwd(), projectName: 'test' } as ToolContext,
  });
  await new ExecutingNode().execute(ctx, null);
  const event = recordedEvents.find((entry) => entry.event === 'tool_call_result');
  return (event!.args as unknown as [string, string, { subUsage?: unknown; subUsageRuns?: unknown }, number])[2];
}

describe('sub-runner usage on tool results', () => {
  it('carries the usage and its run keys to the tool_call_result event', async () => {
    const payload = await emitted({ content: 'child done', subUsage: { input_tokens: 12, output_tokens: 3 }, subUsageRuns: ['child-run:r1'] });
    expect(payload.subUsage).toEqual({ input_tokens: 12, output_tokens: 3 });
    expect(payload.subUsageRuns).toEqual(['child-run:r1']);
  });

  it('adds nothing when the tool reported no sub-runner usage', async () => {
    const payload = await emitted({ content: 'plain' });
    expect(payload).not.toHaveProperty('subUsage');
    expect(payload).not.toHaveProperty('subUsageRuns');
  });
});
