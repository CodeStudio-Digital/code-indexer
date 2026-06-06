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
import { describe, it, expect, vi } from 'vitest';
import type { ChatDelta, ChatUsage } from '@mcp/code-agent/core/messages.js';
import type { ChatProvider } from '@mcp/code-agent/providers/adapter.js';
import type { ToolContext, CoderTool, ToolResult } from '@mcp/code-agent/core/tool.js';
import { ToolRegistry } from '@mcp/code-agent/core/registry.js';
import { ExecutingNode } from '../executing.js';
import { consumeStream } from '../executing-stream.js';
import { makeTestContext } from './test-helpers.js';
import { deriveTokenLimits } from '@mcp/code-agent/core/compaction/limits.js';

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

  it('compacts from the tokenizer estimate when the provider omits usage (Fix B regression)', async () => {
    // Session 887: the ChatGPT backend returns no `usage`, so the old
    // `if (result.usage?.input_tokens)` gate was skipped and compaction never
    // fired. With exactly ONE message the pre-emit gate is bypassed (its
    // `length <= 1` guard), so reaching TokenThresholdHit here can ONLY come
    // from the post-response ESTIMATE fallback.
    const limits = deriveTokenLimits('claude-haiku-4-5-20251001');
    const targetTokens = Math.floor(limits.effective * 0.8); // > 0.70 trigger
    const unit = 'lorem ipsum dolor ';
    const filler = unit.repeat(Math.ceil((targetTokens * 4) / unit.length));
    // A tool_use turn (text-only turns end the run before the compaction gate).
    const { ctx } = makeTestContext({
      provider: makeStreamingProvider([
        { type: 'tool_call_start', id: 'tu1', name: 'echo' },
        { type: 'tool_call_end', id: 'tu1', name: 'echo', input: { msg: 'hi' } },
        // NO usage delta — simulates the ChatGPT backend.
        { type: 'done', stop_reason: 'tool_use' },
      ]),
      registry: makeRegistry({ echo: (input) => `echo: ${input.msg}` }),
      toolContext: emptyToolContext(),
    });
    // Exactly ONE message → the pre-emit gate's `length <= 1` guard skips it,
    // so a TokenThresholdHit can ONLY come from the post-response estimate.
    ctx.messages.length = 0;
    ctx.messages.push({ role: 'user', content: [{ type: 'text', text: filler }] });

    const event = await new ExecutingNode().execute(ctx, null);
    expect(event.kind).toBe('TokenThresholdHit');
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

  it('routes to ToolLoopDetected{guard:"doom-loop"} when the FUZZY window fills (rotating-args loop)', async () => {
    // The fuzzy (name-only) guard catches the real-world create_goal×37
    // pattern: args rotate every turn so tuple-hash never sees a repeat and
    // the dup-call cap stays at 1. This is precisely what the unwired guard
    // was missing in production.
    const deltas: ChatDelta[] = [
      { type: 'tool_call_start', id: 'tg', name: 'create_goal' },
      { type: 'tool_call_end', id: 'tg', name: 'create_goal', input: { text: 'goal-N' } },
      { type: 'usage', usage: { input_tokens: 50, output_tokens: 5 } as ChatUsage },
      { type: 'done', stop_reason: 'tool_use' },
    ];
    const { ctx, recordedEvents } = makeTestContext({
      provider: makeStreamingProvider(deltas),
      registry: makeRegistry({ create_goal: () => 'goal set' }),
      toolContext: emptyToolContext(),
    });
    // 5 prior name-only sigs; this turn's push makes 6 matching → fuzzy fires
    // (default 4-of-6). Strict stays empty (args differ), proving it's the
    // fuzzy variant — not strict — that caught the loop.
    ctx.doomLoop.fuzzy = ['create_goal', 'create_goal', 'create_goal', 'create_goal', 'create_goal'];

    const event = await new ExecutingNode().execute(ctx, null);

    expect(event.kind).toBe('ToolLoopDetected');
    if (event.kind === 'ToolLoopDetected') expect(event.guard).toBe('doom-loop');

    const intervention = recordedEvents.find((e) => e.event === 'tool_loop_intervention');
    const payload = intervention?.args[0] as { kind?: string; severity?: string };
    expect(payload?.kind).toBe('doom-loop-fuzzy');
    expect(payload?.severity).toBe('refused');

    // State reset on fire so the next accumulation starts clean (no
    // Executing↔Planning oscillation).
    expect(ctx.doomLoop.fuzzy).toHaveLength(0);
    expect(ctx.doomLoop.strict).toHaveLength(0);
  });

  it('routes to ToolLoopDetected{guard:"doom-loop"} when the STRICT window repeats (verbatim loop)', async () => {
    const deltas: ChatDelta[] = [
      { type: 'tool_call_start', id: 'ts', name: 'scan' },
      { type: 'tool_call_end', id: 'ts', name: 'scan', input: { path: 'a.ts' } },
      { type: 'usage', usage: { input_tokens: 50, output_tokens: 5 } as ChatUsage },
      { type: 'done', stop_reason: 'tool_use' },
    ];
    const { ctx, recordedEvents } = makeTestContext({
      provider: makeStreamingProvider(deltas),
      registry: makeRegistry({ scan: () => 'scanned' }),
      toolContext: emptyToolContext(),
    });
    // Two prior identical full-signatures; this turn is the 3rd. Keys are
    // sorted by toolCallsSignature.
    const sig = 'scan:{"path":"a.ts"}';
    ctx.doomLoop.strict = [sig, sig];

    // NOTE: this repo's .env cranks CODER_DOOM_LOOP_THRESHOLD to 100 — which
    // also exceeds the 10-entry window, so the strict guard can NEVER fire in
    // that config. Pin the documented default so the wiring is asserted
    // deterministically regardless of ambient env.
    vi.stubEnv('CODER_DOOM_LOOP_THRESHOLD', '3');
    try {
      const event = await new ExecutingNode().execute(ctx, null);
      expect(event.kind).toBe('ToolLoopDetected');
      const intervention = recordedEvents.find((e) => e.event === 'tool_loop_intervention');
      expect((intervention?.args[0] as { kind?: string })?.kind).toBe('doom-loop-strict');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('does NOT trip the doom-loop for a repeatable polling tool (list_* exemption)', async () => {
    // list_subordinates matches REPEATABLE_NAME_PATTERN — a master polling it
    // every turn is the workflow, not a loop. It must be filtered out before
    // the window so a long poll is never derailed into Planning.
    const deltas: ChatDelta[] = [
      { type: 'tool_call_start', id: 'tl', name: 'list_subordinates' },
      { type: 'tool_call_end', id: 'tl', name: 'list_subordinates', input: {} },
      { type: 'usage', usage: { input_tokens: 50, output_tokens: 5 } as ChatUsage },
      { type: 'done', stop_reason: 'tool_use' },
    ];
    const { ctx } = makeTestContext({
      provider: makeStreamingProvider(deltas),
      registry: makeRegistry({ list_subordinates: () => 'still working' }),
      toolContext: emptyToolContext(),
    });
    // Even with a full fuzzy window of prior polls, the exemption means this
    // turn contributes no block → no fire.
    ctx.doomLoop.fuzzy = Array(6).fill('list_subordinates');

    const event = await new ExecutingNode().execute(ctx, null);

    expect(event.kind).toBe('TurnSucceeded');
  });

  it('routes to ToolLoopDetected{guard:"dominance"} when one tool grinds a silent window', async () => {
    // Dominance catches the silent-grind runaway: one tool owning a long
    // window with ZERO assistant text (session 609's 700-turn read_file/grep).
    const deltas: ChatDelta[] = [
      { type: 'tool_call_start', id: 'tr', name: 'read_file' },
      { type: 'tool_call_end', id: 'tr', name: 'read_file', input: { path: 'z.ts' } },
      { type: 'usage', usage: { input_tokens: 50, output_tokens: 5 } as ChatUsage },
      { type: 'done', stop_reason: 'tool_use' },
    ];
    const { ctx, recordedEvents } = makeTestContext({
      provider: makeStreamingProvider(deltas),
      registry: makeRegistry({ read_file: () => 'contents' }),
      toolContext: emptyToolContext(),
    });
    // Small window so the test is fast + deterministic regardless of .env.
    vi.stubEnv('CODER_DOMINANCE_WINDOW', '3');
    vi.stubEnv('CODER_DOMINANCE_RATIO', '0.8'); // ceil(0.8*3)=3 → all 3 must match
    // Two prior silent read_file turns; this turn fills the 3-slot window with
    // no assistant text → grind detected.
    ctx.dominance.window = [
      { name: 'read_file', hadText: false },
      { name: 'read_file', hadText: false },
    ];
    try {
      const event = await new ExecutingNode().execute(ctx, null);
      expect(event.kind).toBe('ToolLoopDetected');
      if (event.kind === 'ToolLoopDetected') expect(event.guard).toBe('dominance');
      const intervention = recordedEvents.find((e) => e.event === 'tool_loop_intervention');
      expect((intervention?.args[0] as { kind?: string })?.kind).toBe('dominance');
      expect(ctx.dominance.window).toHaveLength(0); // reset on fire
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('stays quiet when the dominating tool turns carry assistant text', async () => {
    // Same dominance window, but the agent narrates this turn → not a grind.
    const deltas: ChatDelta[] = [
      { type: 'text_delta', text: 'Reading the next file to confirm the call site.' },
      { type: 'tool_call_start', id: 'tr', name: 'read_file' },
      { type: 'tool_call_end', id: 'tr', name: 'read_file', input: { path: 'z.ts' } },
      { type: 'usage', usage: { input_tokens: 50, output_tokens: 5 } as ChatUsage },
      { type: 'done', stop_reason: 'tool_use' },
    ];
    const { ctx } = makeTestContext({
      provider: makeStreamingProvider(deltas),
      registry: makeRegistry({ read_file: () => 'contents' }),
      toolContext: emptyToolContext(),
    });
    vi.stubEnv('CODER_DOMINANCE_WINDOW', '3');
    vi.stubEnv('CODER_DOMINANCE_RATIO', '0.8');
    ctx.dominance.window = [
      { name: 'read_file', hadText: false },
      { name: 'read_file', hadText: false },
    ];
    try {
      const event = await new ExecutingNode().execute(ctx, null);
      expect(event.kind).toBe('TurnSucceeded');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('does NOT fuzzy-fire when reading files (read_file is fuzzy-exempt)', async () => {
    // The fuzzy guard only watches state-churn tools; reading different files
    // is productive work and must never be flagged — gpt-5.5 reads 1/turn, so
    // a handful of sequential reads would otherwise trip the name-only window.
    const deltas: ChatDelta[] = [
      { type: 'tool_call_start', id: 'tr', name: 'read_file' },
      { type: 'tool_call_end', id: 'tr', name: 'read_file', input: { path: 'unique-A.ts' } },
      { type: 'usage', usage: { input_tokens: 50, output_tokens: 5 } as ChatUsage },
      { type: 'done', stop_reason: 'tool_use' },
    ];
    const { ctx } = makeTestContext({
      provider: makeStreamingProvider(deltas),
      registry: makeRegistry({ read_file: () => 'file body' }),
      toolContext: emptyToolContext(),
    });
    // Even with a full fuzzy window of prior reads, read_file isn't in the
    // fuzzy allowlist → this turn contributes a blank fuzzy sig → no fire.
    ctx.doomLoop.fuzzy = Array(6).fill('read_file');

    const event = await new ExecutingNode().execute(ctx, null);
    expect(event.kind).toBe('TurnSucceeded');
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
