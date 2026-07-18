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
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { AgentMessage, ChatDelta, ChatUsage } from '@mcp/code-agent/core/messages.js';
import type { ChatProvider, ChatRequest } from '@mcp/code-agent/providers/adapter.js';
import type { ToolContext, CoderTool, ToolResult } from '@mcp/code-agent/core/tool.js';
import { ToolRegistry } from '@mcp/code-agent/core/registry.js';
import { ExecutingNode } from '../executing.js';
import { consumeStream, thinkingOnlyBudgetMs } from '../executing-stream.js';
import { makeTestContext } from './test-helpers.js';
import { deriveTokenLimits } from '@mcp/code-agent/core/compaction/limits.js';

function makeStreamingProvider(deltas: ChatDelta[], onRequest?: (request: ChatRequest) => void): ChatProvider {
  return {
    name: 'mock',
    model: 'claude-haiku-4-5-20251001',
    setModel() {},
    async *chat(request: ChatRequest): AsyncIterable<ChatDelta> {
      onRequest?.(request);
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
  it('only exposes get_tool_output when a real recovery snapshot exists', async () => {
    const seenWithoutSnapshot: string[] = [];
    const withoutSnapshot = makeTestContext({
      provider: makeStreamingProvider(
        [{ type: 'text_delta', text: 'done' }, { type: 'done', stop_reason: 'end_turn' }],
        (request) => seenWithoutSnapshot.push(...request.tools.map((tool) => tool.name)),
      ),
      registry: makeRegistry({ get_tool_output: () => 'unused', echo: () => 'unused' }),
      toolContext: {
        ...emptyToolContext(),
        toolOutputStore: { hasOutputs: () => false },
      } as unknown as ToolContext,
    });

    await new ExecutingNode().execute(withoutSnapshot.ctx, null);
    expect(seenWithoutSnapshot).not.toContain('get_tool_output');

    const seenWithSnapshot: string[] = [];
    const withSnapshot = makeTestContext({
      provider: makeStreamingProvider(
        [{ type: 'text_delta', text: 'done' }, { type: 'done', stop_reason: 'end_turn' }],
        (request) => seenWithSnapshot.push(...request.tools.map((tool) => tool.name)),
      ),
      registry: makeRegistry({ get_tool_output: () => 'unused', echo: () => 'unused' }),
      toolContext: {
        ...emptyToolContext(),
        toolOutputStore: { hasOutputs: () => true },
      } as unknown as ToolContext,
    });

    await new ExecutingNode().execute(withSnapshot.ctx, null);
    expect(seenWithSnapshot).toContain('get_tool_output');
  });

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
    const targetTokens = Math.floor(limits.effective * 0.95); // > 0.90 trigger
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

  it('emits producer truncation metadata without deriving it from display text', async () => {
    const sourceTruncations = [{
      technique: 'bounded-stream-cap',
      inputSize: 2_000,
      outputSize: 500,
      unit: 'chars' as const,
      recoverable: false,
    }];
    const { ctx, recordedEvents } = makeTestContext({
      provider: makeStreamingProvider([
        { type: 'tool_call_start', id: 'tu1', name: 'echo' },
        { type: 'tool_call_end', id: 'tu1', name: 'echo', input: {} },
        { type: 'done', stop_reason: 'tool_use' },
      ]),
      registry: makeRegistry({
        echo: () => ({
          content: '[truncated: display marker]',
          sourceTruncations,
        }),
      }),
      toolContext: emptyToolContext(),
    });

    await new ExecutingNode().execute(ctx, null);

    const toolEvent = recordedEvents.find((event) => event.event === 'tool_call_result');
    const payload = (toolEvent!.args as unknown as [string, string, {
      content: string;
      sourceTruncations?: typeof sourceTruncations;
    }, number])[2];
    expect(payload.content).toContain('[truncated: display marker]');
    expect(payload.sourceTruncations).toEqual(sourceTruncations);
  });

  it('emits context_status with the cache-inclusive prompt total from usage', async () => {
    const { ctx, recordedEvents } = makeTestContext({
      provider: makeStreamingProvider([
        { type: 'tool_call_start', id: 'tu1', name: 'echo' },
        { type: 'tool_call_end', id: 'tu1', name: 'echo', input: { msg: 'hi' } },
        {
          type: 'usage',
          // Anthropic-style: input excludes cache; adapter normalizes the total.
          usage: {
            input_tokens: 100,
            output_tokens: 5,
            cache_read_input_tokens: 900,
            prompt_tokens_total: 1000,
          } as ChatUsage,
        },
        { type: 'done', stop_reason: 'tool_use' },
      ]),
      registry: makeRegistry({ echo: (input) => `echo: ${input.msg}` }),
      toolContext: emptyToolContext(),
    });

    await new ExecutingNode().execute(ctx, null);

    const cs = recordedEvents.find((e) => e.event === 'context_status');
    expect(cs).toBeDefined();
    const payload = (cs!.args as [
      { prompt_tokens: number; source: string; context_window: number; ratio: number },
    ])[0];
    expect(payload.prompt_tokens).toBe(1000); // NOT the cache-blind 100
    expect(payload.source).toBe('usage');
    expect(payload.context_window).toBeGreaterThan(0);
    expect(payload.ratio).toBeCloseTo(1000 / payload.context_window, 5);
  });

  it('emits context_status from the estimate when the provider omits usage', async () => {
    const { ctx, recordedEvents } = makeTestContext({
      provider: makeStreamingProvider([
        { type: 'tool_call_start', id: 'tu1', name: 'echo' },
        { type: 'tool_call_end', id: 'tu1', name: 'echo', input: { msg: 'hi' } },
        { type: 'done', stop_reason: 'tool_use' },
      ]),
      registry: makeRegistry({ echo: (input) => `echo: ${input.msg}` }),
      toolContext: emptyToolContext(),
    });

    await new ExecutingNode().execute(ctx, null);

    const cs = recordedEvents.find((e) => e.event === 'context_status');
    expect(cs).toBeDefined();
    const payload = (cs!.args as [{ prompt_tokens: number; source: string }])[0];
    expect(payload.source).toBe('estimate');
    expect(payload.prompt_tokens).toBeGreaterThan(0);
  });

  it('routes to ToolLoopDetected after 3 identical local mutations', async () => {
    const repeatDeltas: ChatDelta[] = [
      { type: 'tool_call_start', id: 'tu1', name: 'echo' },
      { type: 'tool_call_end', id: 'tu1', name: 'echo', input: { msg: 'x' } },
      { type: 'tool_call_start', id: 'tu2', name: 'echo' },
      { type: 'tool_call_end', id: 'tu2', name: 'echo', input: { msg: 'x' } },
      { type: 'tool_call_start', id: 'tu3', name: 'echo' },
      { type: 'tool_call_end', id: 'tu3', name: 'echo', input: { msg: 'x' } },
      { type: 'usage', usage: { input_tokens: 50, output_tokens: 5 } as ChatUsage },
      { type: 'done', stop_reason: 'tool_use' },
    ];
    const registry = makeRegistry({ echo: () => 'pong' });
    Object.assign(registry.get('echo')!, {
      mutates: true,
      repeatPolicy: 'mutating',
      executionClass: 'write',
    });
    const { ctx } = makeTestContext({
      provider: makeStreamingProvider(repeatDeltas),
      registry,
      toolContext: emptyToolContext(),
    });

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

  it('legacy rollback routes to ToolLoopDetected when the FUZZY signature window fills', async () => {
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

    vi.stubEnv('CODER_DEDUP_POLICY', 'legacy');
    const event = await new ExecutingNode().execute(ctx, null);
    vi.unstubAllEnvs();

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

  it('legacy rollback routes to ToolLoopDetected when the STRICT signature window repeats', async () => {
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
    vi.stubEnv('CODER_DEDUP_POLICY', 'legacy');
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
    // list_subordinates is registered as pollable — a master polling it
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

  it('tolerates a long time-to-first-byte (first-byte budget > idle budget)', async () => {
    async function* slowFirstByte(): AsyncIterable<ChatDelta> {
      // Silent longer than the inter-delta idle budget, but within first-byte.
      await sleep(40);
      yield { type: 'text_delta', text: 'hi' };
      yield { type: 'done', stop_reason: 'stop' };
    }
    const r = await consumeStream({
      stream: slowFirstByte(),
      idleTimeoutMs: 10, // would fire at 10ms under the old flat timeout
      firstByteTimeoutMs: 1_000,
    });
    expect(r.textBlocks.join('')).toBe('hi');
  });

  it('accepts a serialized signal-like object without EventTarget methods', async () => {
    async function* immediate(): AsyncIterable<ChatDelta> {
      yield { type: 'text_delta', text: 'ok' };
      yield { type: 'done', stop_reason: 'stop' };
    }
    const signalLike = { aborted: false } as AbortSignal;
    const result = await consumeStream({ stream: immediate(), signal: signalLike });
    expect(result.textBlocks.join('')).toBe('ok');
  });

  it('still times out a mid-stream stall AFTER the first byte (idle budget)', async () => {
    async function* stallAfterFirst(): AsyncIterable<ChatDelta> {
      yield { type: 'text_delta', text: 'hi' }; // first byte is fast
      await sleep(60); // gap exceeds the inter-delta idle budget
      yield { type: 'text_delta', text: 'never' };
    }
    await expect(consumeStream({
      stream: stallAfterFirst(),
      idleTimeoutMs: 10,
      firstByteTimeoutMs: 1_000,
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

  // P2 — when Compacting has already proven the context irreducible (consecutive
  // no-ops), the pre-emit gate must SEND the (still-within-window) request rather
  // than loop into Compacting and eventually abort with `compact_exhausted`.
  function bigHistory(ratio = 0.92): AgentMessage[] {
    const limits = deriveTokenLimits('claude-haiku-4-5-20251001');
    const targetTokens = Math.floor(limits.effective * ratio);
    const unit = 'lorem ipsum dolor ';
    const perMsgChars = Math.ceil((targetTokens * 4) / 2); // text density ≈ chars/4, two msgs
    const filler = unit.repeat(Math.ceil(perMsgChars / unit.length));
    return [
      { role: 'user', content: [{ type: 'text', text: filler }] },
      { role: 'assistant', content: [{ type: 'text', text: filler }] },
    ];
  }

  it('P2: sends instead of routing to Compacting when the context is proven irreducible', async () => {
    const { ctx } = makeTestContext({
      provider: makeStreamingProvider([
        { type: 'text_delta', text: 'all done' },
        { type: 'usage', usage: { input_tokens: 100, output_tokens: 5 } as ChatUsage },
        { type: 'done', stop_reason: 'end_turn' },
      ]),
      registry: makeRegistry({}),
      toolContext: emptyToolContext(),
    });
    ctx.messages = bigHistory();
    ctx.consecutiveNoopCompactions = 2; // Compacting already proved it irreducible

    const event = await new ExecutingNode().execute(ctx, null);

    expect(event.kind).not.toBe('TokenThresholdHit'); // did NOT loop into Compacting
    expect(ctx.stopReason).not.toBe('compact_exhausted'); // did NOT abort
    expect(event.kind).toBe('CleanFinish'); // the request was sent and completed
  });

  it('P2 control: still routes to Compacting (TokenThresholdHit) when not yet proven irreducible', async () => {
    const { ctx } = makeTestContext({
      provider: makeStreamingProvider([
        { type: 'text_delta', text: 'unused — provider should not be reached' },
        { type: 'done', stop_reason: 'end_turn' },
      ]),
      registry: makeRegistry({}),
      toolContext: emptyToolContext(),
    });
    ctx.messages = bigHistory();
    ctx.consecutiveNoopCompactions = 0;

    const event = await new ExecutingNode().execute(ctx, null);
    expect(event.kind).toBe('TokenThresholdHit');
  });

  it('P2 boundary: does NOT bypass when irreducible AND projection exceeds the window', async () => {
    // The <=effective clause must hold the line: a request larger than the model
    // window is never silently sent, even when compaction is proven irreducible.
    const { ctx } = makeTestContext({
      provider: makeStreamingProvider([
        { type: 'text_delta', text: 'unused — provider must not be reached' },
        { type: 'done', stop_reason: 'end_turn' },
      ]),
      registry: makeRegistry({}),
      toolContext: emptyToolContext(),
    });
    ctx.messages = bigHistory(1.1); // projects ABOVE effective
    ctx.consecutiveNoopCompactions = 2; // irreducible — but the request does NOT fit

    const event = await new ExecutingNode().execute(ctx, null);
    expect(event.kind).toBe('TokenThresholdHit'); // routes (eventually aborts), never sends
  });
});

describe('thinkingOnlyBudgetMs', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('returns the base budget for the first attempt at default effort', () => {
    expect(thinkingOnlyBudgetMs(undefined, 0)).toBe(240_000);
    expect(thinkingOnlyBudgetMs('medium', 0)).toBe(240_000);
  });

  it('scales the base by reasoning effort (high 1.5x, xhigh 2x)', () => {
    expect(thinkingOnlyBudgetMs('high', 0)).toBe(360_000);
    expect(thinkingOnlyBudgetMs('xhigh', 0)).toBe(480_000);
  });

  it('doubles per prior attempt so a retry gets strictly more time', () => {
    expect(thinkingOnlyBudgetMs(undefined, 0)).toBe(240_000);
    expect(thinkingOnlyBudgetMs(undefined, 1)).toBe(480_000);
    expect(thinkingOnlyBudgetMs(undefined, 2)).toBe(960_000);
  });

  it('bounds the attempt multiplier at 4x so a degenerate loop stays bounded', () => {
    // attempts beyond 2 do not keep doubling.
    expect(thinkingOnlyBudgetMs(undefined, 3)).toBe(960_000);
    expect(thinkingOnlyBudgetMs(undefined, 10)).toBe(960_000);
  });

  it('resolves the base from CODER_STREAM_THINKING_ONLY_TIMEOUT_MS at call time', () => {
    vi.stubEnv('CODER_STREAM_THINKING_ONLY_TIMEOUT_MS', '60000');
    expect(thinkingOnlyBudgetMs(undefined, 0)).toBe(60_000);
    expect(thinkingOnlyBudgetMs('high', 1)).toBe(180_000); // 60k * 1.5 * 2
  });
});
