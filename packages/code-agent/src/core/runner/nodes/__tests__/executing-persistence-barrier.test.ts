import { describe, expect, it } from 'vitest';
import type { ChatDelta } from '@mcp/code-agent/core/messages.js';
import type { ChatProvider } from '@mcp/code-agent/providers/adapter.js';
import type { CoderTool, ToolContext } from '@mcp/code-agent/core/tool.js';
import { ToolRegistry } from '@mcp/code-agent/core/registry.js';
import { withReasoningCapabilities, withStreamResilience } from '@mcp/provider-sdk';
import type { CollaborationBudget } from '@mcp/session-storage/collaboration/budget.js';
import { budgetedProvider } from '../../../../runtime/ultra-provider.js';
import { wrapProviderForSubagentFence } from '../../../../tools/implement-subagent.js';
import { ExecutingNode } from '../executing.js';
import { makeTestContext } from './test-helpers.js';

describe('ExecutingNode previous-turn persistence barrier', () => {
  it.each(['commit', 'fail'] as const)('overlaps pure inference but holds effects until durability: %s', async (outcome: 'commit' | 'fail') => {
    let resolvePersistence!: () => void;
    let rejectPersistence!: (error: Error) => void;
    const persistence = new Promise<void>((resolve, reject) => { resolvePersistence = resolve; rejectPersistence = reject; });
    let started!: () => void;
    const entered = new Promise<void>((resolve) => { started = resolve; });
    let toolCalls = 0;
    let providerSignal: AbortSignal | undefined;
    const provider: ChatProvider = {
      name: 'pure', model: 'pure', inferenceOnly: true, setModel() {},
      async *chat(req) {
        providerSignal = req.signal;
        started();
        yield { type: 'tool_call_end', id: 'write-2', name: 'write_probe', input: {} };
        yield { type: 'done', stop_reason: 'tool_use' };
      },
    };
    const registry = new ToolRegistry();
    registry.register({ name: 'write_probe', description: 'Probe', source: 'native', mutates: true,
      parallelSafe: false, riskLevel: 'write', parameters: { type: 'object', properties: {} },
      handler: async () => { toolCalls++; return { content: 'written' }; } });
    const ledger = { rootId: 'barrier', state: async () => ({ limits: {} }),
      reserve: async () => undefined, settle: async () => undefined } as unknown as CollaborationBudget;
    const wrapped = wrapProviderForSubagentFence(budgetedProvider(
      withStreamResilience(withReasoningCapabilities(provider, undefined)), ledger), () => undefined);
    const { ctx, recordedEvents } = makeTestContext({ provider: wrapped, registry,
      toolContext: { cwd: process.cwd(), projectName: 'barrier-test' } as ToolContext });
    ctx.bridge = { awaitTurnPersistence: () => persistence };
    const running = new ExecutingNode().execute(ctx, null);
    await entered;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(toolCalls).toBe(0);
    expect(ctx.messages.some((m) => m.role === 'assistant')).toBe(false);
    if (outcome === 'fail') {
      rejectPersistence(new Error('disk commit failed'));
      await expect(running).rejects.toThrow('disk commit failed');
      expect(providerSignal?.aborted).toBe(true);
      expect(toolCalls).toBe(0);
    } else {
      resolvePersistence();
      await running;
      expect(toolCalls).toBe(1);
      expect(recordedEvents.some((e) => e.event === 'message_complete')).toBe(true);
    }
  });

  it('cancels a still-streaming pure provider promptly when persistence fails', async () => {
    let rejectPersistence!: (error: Error) => void;
    const persistence = new Promise<void>((_, reject) => { rejectPersistence = reject; });
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    let aborted = false;
    const provider: ChatProvider = { name: 'pure', model: 'pure', inferenceOnly: true, setModel() {},
      async *chat(req) {
        entered();
        await new Promise<void>((resolve) => req.signal!.addEventListener('abort', () => { aborted = true; resolve(); }, { once: true }));
        yield { type: 'done' };
      } };
    const { ctx } = makeTestContext({ provider, registry: new ToolRegistry(),
      toolContext: { cwd: process.cwd(), projectName: 'barrier-test' } as ToolContext });
    ctx.bridge = { awaitTurnPersistence: () => persistence };
    const running = new ExecutingNode().execute(ctx, null);
    await started;
    rejectPersistence(new Error('disk gone'));
    await expect(running).rejects.toThrow('disk gone');
    expect(aborted).toBe(true);
    expect(ctx.messages.some((m) => m.role === 'assistant')).toBe(false);
  });

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
