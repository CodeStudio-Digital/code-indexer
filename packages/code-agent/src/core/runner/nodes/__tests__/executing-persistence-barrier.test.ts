import { describe, expect, it } from 'vitest';
import type { ChatDelta } from '@mcp/code-agent/core/messages.js';
import type { ChatProvider } from '@mcp/code-agent/providers/adapter.js';
import type { CoderTool, ToolContext } from '@mcp/code-agent/core/tool.js';
import { ToolRegistry } from '@mcp/code-agent/core/registry.js';
import { ExecutingNode } from '../executing.js';
import { makeTestContext } from './test-helpers.js';

describe('ExecutingNode previous-turn persistence barrier', () => {
  it('runs no provider or tool from the next turn while persistence is pending or rejected', async () => {
    let rejectPersistence!: (error: Error) => void;
    const persistence = new Promise<void>((_resolve, reject) => {
      rejectPersistence = reject;
    });
    let providerCalls = 0;
    let toolCalls = 0;

    const provider: ChatProvider = {
      name: 'mock',
      model: 'mock-model',
      setModel() {},
      async *chat(): AsyncIterable<ChatDelta> {
        providerCalls += 1;
        yield { type: 'tool_call_start', id: 'next-turn-tool', name: 'write_probe' };
        yield {
          type: 'tool_call_end',
          id: 'next-turn-tool',
          name: 'write_probe',
          input: {},
        };
        yield { type: 'done', stop_reason: 'tool_use' };
      },
    };
    const registry = new ToolRegistry();
    const writeProbe: CoderTool = {
      name: 'write_probe',
      description: 'Detect whether the next turn reached tool dispatch.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      source: 'native',
      mutates: true,
      parallelSafe: false,
      riskLevel: 'write',
      handler: async () => {
        toolCalls += 1;
        return { content: 'ran' };
      },
    };
    registry.register(writeProbe);

    const { ctx } = makeTestContext({
      provider,
      registry,
      toolContext: {
        cwd: process.cwd(),
        projectName: 'test',
      } as ToolContext,
    });
    // Model this as the second Executing visit: `turn_start` is responsible for
    // scheduling the preceding turn's goal/transcript transaction.
    ctx.turn = 1;
    ctx.bridge = {
      awaitTurnPersistence: () => persistence,
    };

    const nextTurn = new ExecutingNode().execute(ctx, null);
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(ctx.turn).toBe(2);
    expect(providerCalls).toBe(0);
    expect(toolCalls).toBe(0);

    rejectPersistence(new Error('goal CAS failed'));
    await expect(nextTurn).rejects.toThrow('goal CAS failed');
    expect(providerCalls).toBe(0);
    expect(toolCalls).toBe(0);
  });
});
