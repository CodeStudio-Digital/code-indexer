/**
 * Smoke tests for the Executing node. We use a real ToolRegistry with a
 * single hand-rolled tool plus an async-generator provider so the node's
 * pipeline runs end-to-end without external dependencies.
 *
 * Scope: the three terminal outcomes Commit 6 covers — CleanFinish,
 * TurnSucceeded (with tools), ToolLoopDetected (via dedup refusal). Token-
 * threshold and provider-error paths are exercised by the threshold /
 * recovering tests respectively; here we focus on the integration glue.
 */
import { describe, it, expect } from 'vitest';
import type { ChatDelta, ChatUsage } from '@mcp/code-agent/core/messages.js';
import type { ChatProvider } from '@mcp/code-agent/providers/adapter.js';
import type { ToolContext, CoderTool, ToolResult } from '@mcp/code-agent/core/tool.js';
import { ToolRegistry } from '@mcp/code-agent/core/registry.js';
import { ExecutingNode } from '../executing.js';
import { makeTestContext } from './test-helpers.js';

function makeStreamingProvider(deltas: ChatDelta[]): ChatProvider {
  return {
    name: 'mock',
    model: 'claude-haiku-4-5-20251001',
    setModel() {},
    async *chat(): AsyncIterable<ChatDelta> {
      for (const d of deltas) yield d;
    },
  };
}

function makeRegistry(handlers: Record<string, (input: Record<string, unknown>) => string | ToolResult>): ToolRegistry {
  const r = new ToolRegistry();
  for (const [name, fn] of Object.entries(handlers)) {
    const tool: CoderTool = {
      name,
      description: `mock tool ${name}`,
      parameters: { type: 'object', properties: {} },
      source: 'native',
      handler: async (args: Record<string, unknown>) => {
        const raw = fn(args);
        if (typeof raw === 'string') return { content: raw };
        return raw;
      },
    };
    r.register(tool);
  }
  return r;
}

function emptyToolContext(): ToolContext {
  return {
    cwd: process.cwd(),
    projectName: 'test',
  } as ToolContext;
}

describe('ExecutingNode', () => {
  it('emits CleanFinish when the assistant returns text and no tool_use', async () => {
    const { ctx } = makeTestContext({
      provider: makeStreamingProvider([
        { type: 'text_delta', text: 'all done' },
        { type: 'usage', usage: { input_tokens: 100, output_tokens: 10 } as ChatUsage },
        { type: 'done', stop_reason: 'end_turn' },
      ]),
      registry: makeRegistry({}),
      toolContext: emptyToolContext(),
    });

    const event = await new ExecutingNode().execute(ctx, null);

    expect(event.kind).toBe('CleanFinish');
    expect(ctx.stopReason).toBe('completed');
    // Assistant message landed in history.
    expect(ctx.messages.at(-1)?.role).toBe('assistant');
    expect(ctx.turn).toBe(1);
  });

  it('emits TurnSucceeded and pushes tool_result when assistant emits a tool_use', async () => {
    const { ctx, recordedEvents } = makeTestContext({
      provider: makeStreamingProvider([
        { type: 'tool_call_start', id: 'tu1', name: 'echo' },
        { type: 'tool_call_end', id: 'tu1', name: 'echo', input: { msg: 'hi' } },
        { type: 'usage', usage: { input_tokens: 100, output_tokens: 5 } as ChatUsage },
        { type: 'done', stop_reason: 'tool_use' },
      ]),
      registry: makeRegistry({ echo: (input) => `echo: ${input.msg}` }),
      toolContext: emptyToolContext(),
    });

    const event = await new ExecutingNode().execute(ctx, null);

    expect(event.kind).toBe('TurnSucceeded');
    if (event.kind === 'TurnSucceeded') expect(event.hasToolCalls).toBe(true);

    // History grew by assistant + tool.
    const tail = ctx.messages.slice(-2);
    expect(tail[0].role).toBe('assistant');
    expect(tail[1].role).toBe('tool');
    expect(JSON.stringify(tail[1].content)).toContain('echo: hi');

    // tool_call_result event was emitted.
    const toolEvent = recordedEvents.find((e) => e.event === 'tool_call_result');
    expect(toolEvent).toBeDefined();
  });

  it('routes to ToolLoopDetected after 3 identical calls (tuple-hash refuse)', async () => {
    const repeatDeltas: ChatDelta[] = [
      { type: 'tool_call_start', id: 'tu1', name: 'echo' },
      { type: 'tool_call_end', id: 'tu1', name: 'echo', input: { msg: 'x' } },
      { type: 'usage', usage: { input_tokens: 50, output_tokens: 5 } as ChatUsage },
      { type: 'done', stop_reason: 'tool_use' },
    ];
    const { ctx } = makeTestContext({
      provider: makeStreamingProvider(repeatDeltas),
      registry: makeRegistry({ echo: () => 'pong' }),
      toolContext: emptyToolContext(),
    });

    // Pre-seed two prior identical calls so the next is the 3rd.
    ctx.dupCalls.set('echo|{"msg":"x"}', { count: 2, firstTurn: 1, lastUseId: 'prev' });

    const event = await new ExecutingNode().execute(ctx, null);

    expect(event.kind).toBe('ToolLoopDetected');
    if (event.kind === 'ToolLoopDetected') {
      expect(event.guard).toBe('tuple-hash');
    }
    // Tool result was synthesized as an error (no real invocation).
    const lastMsg = ctx.messages.at(-1);
    expect(lastMsg?.role).toBe('tool');
    expect(JSON.stringify(lastMsg?.content)).toMatch(/loop-refused/);
  });

  it('emits ProviderError on a synchronous chat() throw', async () => {
    const brokenProvider: ChatProvider = {
      name: 'mock',
      model: 'claude-haiku-4-5-20251001',
      setModel() {},
      chat() {
        throw Object.assign(new Error('rate limited'), { status: 429 });
      },
    };
    const { ctx } = makeTestContext({
      provider: brokenProvider,
      registry: makeRegistry({}),
      toolContext: emptyToolContext(),
    });

    const event = await new ExecutingNode().execute(ctx, null);

    expect(event.kind).toBe('ProviderError');
    if (event.kind === 'ProviderError') {
      expect(event.status).toBe(429);
      expect(event.retryable).toBe(true);
    }
  });
});
