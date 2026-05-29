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
import { consumeStream } from '../executing-stream.js';
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

  it('routes to ToolLoopDetected{guard:"failure-streak"} after the 5th consecutive failure', async () => {
    // Tool that always fails. The pre-seeded streak puts us at 4
    // failures already → the next dispatch is the 5th and crosses the
    // refuse threshold.
    const failingDeltas: ChatDelta[] = [
      { type: 'tool_call_start', id: 'tu5', name: 'write_stdin' },
      // Rotating args defeat the tuple-hash dedup so we know it is the
      // failure-streak that fires, not tuple-hash.
      { type: 'tool_call_end', id: 'tu5', name: 'write_stdin', input: { session_id: 'B' } },
      { type: 'usage', usage: { input_tokens: 50, output_tokens: 5 } as ChatUsage },
      { type: 'done', stop_reason: 'tool_use' },
    ];
    const { ctx, recordedEvents } = makeTestContext({
      provider: makeStreamingProvider(failingDeltas),
      registry: makeRegistry({
        write_stdin: () => ({ content: 'session not active', isError: true }),
      }),
      toolContext: emptyToolContext(),
    });

    ctx.failureStreaks.streaks.set('write_stdin', {
      consecutive: 4,
      firstFailureTurn: 1,
      lastFailureTurn: 4,
      lastError: 'session not active',
    });

    const event = await new ExecutingNode().execute(ctx, null);

    expect(event.kind).toBe('ToolLoopDetected');
    if (event.kind === 'ToolLoopDetected') {
      expect(event.guard).toBe('failure-streak');
    }
    expect(ctx.failureStreaks.streaks.get('write_stdin')?.consecutive).toBe(5);

    // The tool_result content has been REPLACED with the refusal text.
    const lastMsg = ctx.messages.at(-1);
    expect(JSON.stringify(lastMsg?.content)).toMatch(/failure-streak REFUSED/);

    // The runner emitted a tool_loop_intervention event tagged
    // 'failure-streak' so the dashboard sees the banner.
    const intervention = recordedEvents.find((e) => e.event === 'tool_loop_intervention');
    expect(intervention).toBeDefined();
    const payload = intervention?.args[0] as { kind?: string; severity?: string };
    expect(payload?.kind).toBe('failure-streak');
    expect(payload?.severity).toBe('refused');
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

  it('routes provider stream abort to Aborted instead of ProviderError', async () => {
    const abort = new AbortController();
    abort.abort();
    const { ctx, recordedEvents } = makeTestContext({
      provider: makeStreamingProvider([
        { type: 'text_delta', text: 'should not matter' },
      ]),
      registry: makeRegistry({}),
      toolContext: { ...emptyToolContext(), signal: abort.signal },
    });

    const event = await new ExecutingNode().execute(ctx, null);

    expect(event.kind).toBe('Aborted');
    expect(ctx.stopReason).toBe('aborted');
    expect(recordedEvents).toContainEqual(expect.objectContaining({
      event: 'operation_finished',
      args: [expect.objectContaining({ status: 'aborted', kind: 'provider' })],
    }));
  });

  it('times out thinking-only provider streams', async () => {
    async function* thinkingOnly(): AsyncIterable<ChatDelta> {
      yield { type: 'thinking_delta', text: 'still thinking' };
      await sleep(20);
      yield { type: 'thinking_delta', text: 'still only thinking' };
    }

    await expect(consumeStream({
      stream: thinkingOnly(),
      idleTimeoutMs: 1_000,
      thinkingOnlyTimeoutMs: 1,
    })).rejects.toMatchObject({ name: 'TimeoutError', code: 'TIMEOUT' });
  });

  it('aborts the tool invocation signal when a tool deadline expires', async () => {
    let sawAbort = false;
    const registry = new ToolRegistry();
    registry.register({
      name: 'slow_tool',
      description: 'slow test tool',
      parameters: { type: 'object', properties: {} },
      source: 'native',
      timeoutMs: 5,
      handler: async (_args, toolCtx) => new Promise<ToolResult>((resolve) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const finish = (result: ToolResult): void => {
          if (timer) clearTimeout(timer);
          resolve(result);
        };
        if (toolCtx.signal?.aborted) {
          sawAbort = true;
          finish({ content: 'aborted immediately' });
          return;
        }
        toolCtx.signal?.addEventListener('abort', () => {
          sawAbort = true;
          finish({ content: 'aborted by deadline' });
        }, { once: true });
        timer = setTimeout(() => finish({ content: 'late success' }), 1_000);
      }),
    });
    const { ctx } = makeTestContext({
      provider: makeStreamingProvider([
        { type: 'tool_call_start', id: 'tu-slow', name: 'slow_tool' },
        { type: 'tool_call_end', id: 'tu-slow', name: 'slow_tool', input: {} },
        { type: 'done', stop_reason: 'tool_use' },
      ]),
      registry,
      toolContext: emptyToolContext(),
    });

    const event = await new ExecutingNode().execute(ctx, null);
    await sleep(0);

    expect(event.kind).toBe('TurnSucceeded');
    expect(sawAbort).toBe(true);
    expect(JSON.stringify(ctx.messages.at(-1)?.content)).toContain('[tool-timeout: `slow_tool` exceeded');
  });
});
