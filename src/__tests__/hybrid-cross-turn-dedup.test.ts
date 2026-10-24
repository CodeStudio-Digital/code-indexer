/** Hybrid dedup never refuses an invocation merely because it appeared earlier. */
import { describe, expect, it } from 'vitest';
import { CoderRunner } from '@mcp/code-agent/core/runner.js';
import { ToolRegistry } from '@mcp/code-agent/core/registry.js';
import type { CoderTool } from '@mcp/code-agent/core/tool.js';
import type { ChatProvider, ChatRequest } from '@mcp/code-agent/providers/adapter.js';
import type { ChatDelta } from "@mcp/provider-sdk";

class RepeatingProvider implements ChatProvider {
  readonly name = 'repeater';
  model = 'rep-1';
  private callCount = 0;

  constructor(
    private readonly toolName: string,
    private readonly toolInput: Record<string, unknown>,
    private readonly maxCalls: number,
  ) {}

  setModel(model: string): void { this.model = model; }

  async *chat(_req: ChatRequest): AsyncIterable<ChatDelta> {
    this.callCount += 1;
    if (this.callCount > this.maxCalls) {
      yield { type: 'text_delta', text: 'done' };
      yield { type: 'usage', usage: { input_tokens: 5, output_tokens: 1 } };
      yield { type: 'done' };
      return;
    }
    const id = `tu_${this.callCount}`;
    yield { type: 'tool_call_start', id, name: this.toolName };
    yield { type: 'tool_call_end', id, name: this.toolName, input: this.toolInput };
    yield { type: 'usage', usage: { input_tokens: 5, output_tokens: 1 } };
    yield { type: 'done' };
  }
}

function runRepeatedTool(repeatPolicy: CoderTool['repeatPolicy'], content: string): {
  run: () => Promise<void>;
  count: () => number;
} {
  let calls = 0;
  const tool: CoderTool = {
    name: 'status_tool',
    description: 'mock',
    source: 'native',
    mutates: false,
    parallelSafe: true,
    repeatPolicy,
    executionClass: 'read',
    parameters: { type: 'object', properties: { scope: { type: 'string' } } },
    handler: async () => {
      calls += 1;
      return { content, isError: false };
    },
  };
  const registry = new ToolRegistry();
  registry.register(tool);
  const runner = new CoderRunner({
    provider: new RepeatingProvider('status_tool', { scope: 'same' }, 3),
    registry,
    systemPrompt: 'sys',
    toolContext: { cwd: '/tmp', projectName: 'test' },
    initialMessages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }],
    agentLoopV2: true,
    maxTurns: 20,
  });
  return { run: async () => { await runner.run(); }, count: () => calls };
}

describe('hybrid cross-turn dedup', () => {
  // Exercise cross-turn reuse below the independent five-repeat loop guard.
  it('executes stable calls again on later turns even with identical args/results', async () => {
    const scenario = runRepeatedTool('stable', 'unchanged snapshot'.repeat(8));
    await scenario.run();
    expect(scenario.count()).toBe(3);
  });

  it.each(['volatile', 'pollable'] as const)('%s calls always execute', async (policy) => {
    const scenario = runRepeatedTool(policy, 'unchanged live status'.repeat(8));
    await scenario.run();
    expect(scenario.count()).toBe(3);
  });
});
