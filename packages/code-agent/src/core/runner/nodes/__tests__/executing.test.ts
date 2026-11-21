/**
 * Smoke tests for the Executing node. We use a real ToolRegistry with a
 * single hand-rolled tool plus an async-generator provider so the node's
 * pipeline runs end-to-end without external dependencies.
 *
 * Scope: the terminal outcomes Commit 6 covers — CleanFinish and
 * TurnSucceeded (with tools). Token-
 * threshold and provider-error paths are exercised by the threshold /
 * recovering tests respectively; here we focus on the integration glue.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { AgentMessage, ChatDelta, ChatUsage } from '@mcp/code-agent/core/messages.js';
import type { ChatProvider, ChatRequest } from '@mcp/code-agent/providers/adapter.js';
import type { ToolContext, CoderTool, ToolResult } from '@mcp/code-agent/core/tool.js';
import { ToolRegistry } from '@mcp/code-agent/core/registry.js';
import { ToolCallLedger } from '@mcp/code-agent/core/tool-call-ledger.js';
import { ExecutingNode } from '../executing.js';
import { consumeStream } from '../executing-stream.js';
import { makeTestContext } from './test-helpers.js';
import { deriveTokenLimits } from '@mcp/code-agent/core/compaction/limits.js';
import { HookBus, type HookDefinition } from '@mcp/code-agent/core/hook-bus.js';
import { asSessionId } from '@mcp/session-storage';

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

function makeSequencedProvider(turns: ChatDelta[][]): ChatProvider {
  let nextTurn = 0;
  return {
    name: 'mock',
    model: 'claude-haiku-4-5-20251001',
    setModel() {},
    async *chat(): AsyncIterable<ChatDelta> {
      const deltas = turns[Math.min(nextTurn, turns.length - 1)] ?? [];
      nextTurn += 1;
      for (const delta of deltas) yield delta;
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
  it('resets consecutive retries only on a committed response and retains run totals', async () => {
    const { ctx } = makeTestContext({
      provider: makeStreamingProvider([{ type: 'text_delta', text: 'complete' }, { type: 'done' }]),
      registry: makeRegistry({}), toolContext: emptyToolContext(),
    });
    ctx.transportRetriesThisTurn = 3;
    ctx.transientRetriesThisTurn = 1;
    ctx.recovery.set('provider-transport-retry', 7);
    await new ExecutingNode().execute(ctx, null);
    expect(ctx.transportRetriesThisTurn).toBe(0);
    expect(ctx.transientRetriesThisTurn).toBe(0);
    expect(ctx.recovery.get('provider-transport-retry')).toBe(7);
  });

  it('does not dispatch streamed tools on disconnect and records the safe nested cause', async () => {
    const effect = vi.fn(() => 'written');
    let attempt = 0;
    const provider: ChatProvider = {
      name: 'mock', model: 'mock', setModel() {},
      async *chat() {
        yield { type: 'tool_call_end', id: 'write_once', name: 'echo', input: {} };
        if (++attempt === 1) throw new TypeError('terminated', {
          cause: Object.assign(new Error('https://private/?key=secret'), { code: 'UND_ERR_SOCKET' }),
        });
        yield { type: 'done', stop_reason: 'tool_use' };
      },
    };
    const recordProviderAttempt = vi.fn();
    const { ctx } = makeTestContext({ provider, registry: makeRegistry({ echo: effect }), toolContext: emptyToolContext() });
    ctx.opts.sessionStore = { recordProviderAttempt } as never;
    ctx.transportRetriesThisTurn = 2;
    expect((await new ExecutingNode().execute(ctx, null)).kind).toBe('ProviderError');
    expect(effect).not.toHaveBeenCalled();
    expect(ctx.messages).toHaveLength(0);
    expect(ctx.transportRetriesThisTurn).toBe(2);
    expect(recordProviderAttempt).toHaveBeenCalledWith(expect.objectContaining({
      ok: false, error_code: 'UND_ERR_SOCKET',
      error_message: 'Provider connection interrupted before the response completed (UND_ERR_SOCKET)',
    }));
    await new ExecutingNode().execute(ctx, null);
    expect(effect).toHaveBeenCalledTimes(1);
    expect(ctx.transportRetriesThisTurn).toBe(0);
  });

  it('commits an image-only generation to the assistant message and dashboard event', async () => {
    const image: ChatDelta = { type: 'image_generated', id: 'img_1', mediaType: 'image/png', base64: Buffer.from('pixels').toString('base64') };
    const { ctx, recordedEvents } = makeTestContext({
      provider: makeStreamingProvider([image, image, { type: 'done', stop_reason: 'stop' }]),
      registry: makeRegistry({}), toolContext: emptyToolContext(),
    });
    expect((await new ExecutingNode().execute(ctx, null)).kind).toBe('CleanFinish');
    const expected = { role: 'assistant', phase: 'final_answer', content: [
      { type: 'image', name: 'generated-img_1.png', mediaType: 'image/png', base64: image.base64 },
    ] };
    expect(ctx.messages).toContainEqual(expected);
    expect(recordedEvents.find(event => event.event === 'message_complete')?.args[0]).toEqual(expected);
  });

  it('emits the fast tool result while another tool is still pending', async () => {
    const registry = new ToolRegistry();
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const slow = new Promise<void>((resolve) => { release = resolve; });
    for (const name of ['fast_read', 'slow_read']) registry.register({
      name, description: name, source: 'native', parameters: { type: 'object', properties: {} },
      handler: async () => { if (name === 'slow_read') { entered(); await slow; } return { content: name }; },
    });
    const { ctx, recordedEvents } = makeTestContext({ registry, toolContext: emptyToolContext(),
      provider: makeStreamingProvider([
        { type: 'tool_call_end', id: 'fast', name: 'fast_read', input: {} },
        { type: 'tool_call_end', id: 'slow', name: 'slow_read', input: {} },
        { type: 'done', stop_reason: 'tool_use' },
      ]),
    });
    ctx.activeTiers = null;
    const pending = new ExecutingNode().execute(ctx, null);
    try {
      await started;
      expect(recordedEvents.filter((event) => event.event === 'tool_call_result').map((event) => event.args[0]))
        .toEqual(['fast']);
    } finally { release(); }
    await pending;
    expect(recordedEvents.filter((event) => event.event === 'tool_call_result').map((event) => event.args[0]))
      .toEqual(['fast', 'slow']);
  });

  it('fires provider and capability lifecycle hooks in order and contains failures', async () => {
    const order: string[] = [];
    const bus = new HookBus();
    const observe = (
      hookId: string,
      stage: HookDefinition['stage'],
      handler: HookDefinition['handler'],
      priority = 100,
    ) => bus.register({
      hookId,
      version: '1',
      kind: 'observation',
      stage,
      source: 'system',
      trustLevel: 'trusted_process',
      timeoutMs: 100,
      priority,
      failurePolicy: 'open',
      idempotency: 'none',
      redactionPolicyRef: 'test',
      handler,
    });
    observe('provider-before', 'before_provider_call', () => { order.push('provider-before'); });
    observe('provider-after', 'after_provider_call', () => { order.push('provider-after'); });
    observe('capability-failure', 'before_capability', () => { throw new Error('contained'); }, 1);
    observe('capability-before', 'before_capability', (ctx) => {
      expect(ctx).not.toHaveProperty('toolInput');
      order.push('capability-before');
    });
    observe('capability-after', 'after_capability', () => { order.push('capability-after'); });

    const handler = vi.fn(() => 'ok');
    const { ctx } = makeTestContext({
      provider: makeStreamingProvider([
        { type: 'tool_call_start', id: 'tu-hook', name: 'echo' },
        { type: 'tool_call_end', id: 'tu-hook', name: 'echo', input: { secret: 'not-for-hooks' } },
        { type: 'done', stop_reason: 'tool_use' },
      ]),
      registry: makeRegistry({ echo: handler }),
      toolContext: emptyToolContext(),
      hookBus: bus,
    });

    const event = await new ExecutingNode().execute(ctx, null);
    expect(event.kind).toBe('TurnSucceeded');
    expect(handler).toHaveBeenCalledTimes(1);
    expect(order).toEqual([
      'provider-before',
      'provider-after',
      'capability-before',
      'capability-after',
    ]);
  });

  it('records provider-managed fallback without inventing an HTTP status', async () => {
    const recordProviderAttempt = vi.fn();
    const { ctx } = makeTestContext({
      provider: makeStreamingProvider([
        { type: 'text_delta', text: 'done' },
        { type: 'usage', usage: { input_tokens: 12, output_tokens: 3 } as ChatUsage },
        { type: 'done', stop_reason: 'end_turn' },
      ]),
      registry: makeRegistry({}),
      toolContext: emptyToolContext(),
    });
    ctx.opts.sessionStore = { recordProviderAttempt } as never;

    await new ExecutingNode().execute(ctx, null);
    expect(recordProviderAttempt).toHaveBeenCalledTimes(1);
    expect(recordProviderAttempt).toHaveBeenCalledWith(expect.objectContaining({
      attempt: 1,
      ok: true,
      status: null,
      input_tokens: 12,
      output_tokens: 3,
    }));
  });

  it('uses adapter response metadata for the provider-managed fallback attempt', async () => {
    const recordProviderAttempt = vi.fn();
    const { ctx } = makeTestContext({
      provider: makeStreamingProvider([
        {
          type: 'response_meta',
          meta: {
            path: '/v1/messages',
            response: {
              status: 201,
              ok: true,
              request_id: 'req-anthropic-known',
              retry_after: '4',
            },
          },
        },
        { type: 'text_delta', text: 'done' },
        { type: 'done', stop_reason: 'end_turn' },
      ]),
      registry: makeRegistry({}),
      toolContext: emptyToolContext(),
    });
    ctx.opts.sessionStore = { recordProviderAttempt } as never;

    await new ExecutingNode().execute(ctx, null);

    expect(recordProviderAttempt).toHaveBeenCalledWith(expect.objectContaining({
      attempt: 1,
      ok: true,
      status: 201,
      request_id: 'req-anthropic-known',
      retry_after: '4',
    }));
  });

  it('keeps get_tool_output projected before and after the first recovery snapshot', async () => {
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
    expect(seenWithoutSnapshot).toContain('get_tool_output');

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
    expect(seenWithSnapshot).toEqual(seenWithoutSnapshot);
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
    ctx.transientRetriesThisTurn = 2;

    const event = await new ExecutingNode().execute(ctx, null);

    expect(event.kind).toBe('CleanFinish');
    expect(ctx.stopReason).toBe('completed');
    // Assistant message landed in history.
    expect(ctx.messages.at(-1)?.role).toBe('assistant');
    expect(ctx.turn).toBe(1);
    expect(ctx.transientRetriesThisTurn).toBe(0);
  });

  it.each(['src/a.ts', 'analysis/atlas.md'])('finishes on the first final reply after writing %s', async (path) => {
    const registry = new ToolRegistry();
    registry.register({
      name: 'edit_file',
      description: 'edit',
      parameters: { type: 'object', properties: {} },
      source: 'native',
      mutates: true,
      riskLevel: 'write',
      executionClass: 'write',
      handler: async () => ({ content: 'edited' }),
    });
    const ledger = new ToolCallLedger();
    const { ctx } = makeTestContext({
      provider: makeStreamingProvider([
        { type: 'text_delta', text: 'all done' },
        { type: 'done', stop_reason: 'end_turn' },
      ]),
      registry,
      toolContext: {
        ...emptyToolContext(),
        toolCallLedger: ledger,
      },
    });
    ledger.record({
      name: 'edit_file',
      args: { path },
      content: 'edited',
      isError: false,
      mutates: true,
      executionClass: 'write',
    });
    ctx.opts.verificationEvidenceEnabled = true;
    const persistTurnTelemetry = vi.fn();
    ctx.bridge = {
      persistTurnTelemetry,
      getSessionStateData: () => ({
        activePlan: null,
        todos: [],
        notes: [],
        filesChanged: [path],
        investigationCount: 0,
      }),
    };

    const chat = vi.spyOn(ctx.opts.provider, 'chat');
    expect((await new ExecutingNode().execute(ctx, null)).kind).toBe('CleanFinish');
    expect(ctx.stopReason).toBe('completed');
    expect(ctx.messages.at(-1)?.role).toBe('assistant');
    expect(chat).toHaveBeenCalledTimes(1);
    expect(persistTurnTelemetry).toHaveBeenCalledTimes(1);
  });

  it.each([
    { path: 'src/a.ts', expectsReminder: true },
    { path: 'docs/atlas.md', expectsReminder: false },
  ])('includes any verification reminder during the tool loop for $path', async ({ path, expectsReminder }) => {
    const registry = new ToolRegistry();
    const tools = [
      { name: 'edit_file', mutates: true, riskLevel: 'write', executionClass: 'write' },
      { name: 'read_file', mutates: false, riskLevel: 'read', executionClass: 'read' },
    ] as const;
    for (const tool of tools) {
      registry.register({
        ...tool, description: tool.name, parameters: { type: 'object', properties: {} }, source: 'native',
        handler: async () => ({ content: 'ok' }),
      });
    }
    const provider = makeSequencedProvider([
      [{ type: 'tool_call_end', id: 'edit', name: 'edit_file', input: { path } }, { type: 'done', stop_reason: 'tool_use' }],
      [{ type: 'tool_call_end', id: 'read', name: 'read_file', input: { path } }, { type: 'done', stop_reason: 'tool_use' }],
      [{ type: 'text_delta', text: 'Delivered.' }, { type: 'done', stop_reason: 'end_turn' }],
    ]);
    const { ctx } = makeTestContext({
      provider, registry, toolContext: { ...emptyToolContext(), toolCallLedger: new ToolCallLedger() },
    });
    ctx.opts.verificationEvidenceEnabled = true;
    ctx.messages.push({ role: 'user', content: [{ type: 'text', text: 'Update the file.' }] });
    const chat = vi.spyOn(provider, 'chat');
    const node = new ExecutingNode();
    const edited = await node.execute(ctx, null);
    expect(edited).toMatchObject({ kind: 'TurnSucceeded', hasToolCalls: true });
    const inspected = await node.execute(ctx, edited);
    expect(inspected).toMatchObject({ kind: 'TurnSucceeded', hasToolCalls: true });
    expect((await node.execute(ctx, inspected)).kind).toBe('CleanFinish');

    const reminder = 'No validation was recorded after the latest write.';
    expect(chat).toHaveBeenCalledTimes(3);
    expect(chat.mock.calls.map(([request]) => JSON.stringify(request.messages).includes(reminder)))
      .toEqual([false, expectsReminder, false]);
    expect(JSON.stringify(ctx.messages)).not.toContain(reminder);
    expect(ctx.messages.at(-1)?.role).toBe('assistant');
  });

  it('finishes after successful validation and a report without another provider round', async () => {
    const ledger = new ToolCallLedger();
    const { ctx } = makeTestContext({
      provider: makeStreamingProvider([
        { type: 'text_delta', text: 'Implemented, tested and documented.' },
        { type: 'done', stop_reason: 'end_turn' },
      ]),
      registry: makeRegistry({}),
      toolContext: { ...emptyToolContext(), toolCallLedger: ledger },
    });
    ledger.record({ name: 'edit_file', args: { path: 'src/a.ts' }, content: 'ok', isError: false, mutates: true, executionClass: 'write' });
    ledger.record({ name: 'run_command', args: { command: 'pnpm test > test.log && node node_modules/typescript/bin/tsc --noEmit' }, content: 'exit code 0', isError: false, executionClass: 'execute' });
    ledger.record({ name: 'edit_file', args: { path: 'REPORT.md' }, content: 'ok', isError: false, mutates: true, executionClass: 'write' });
    ctx.opts.verificationEvidenceEnabled = true;
    expect((await new ExecutingNode().execute(ctx, null)).kind).toBe('CleanFinish');
    expect(ctx.verification.reminderSent).toBe(false);
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

  it('does not compact a queued milestone while a 1M context still has ample room', async () => {
    const { ctx } = makeTestContext({
      provider: makeStreamingProvider([
        { type: 'tool_call_start', id: 'tu1', name: 'echo' },
        { type: 'tool_call_end', id: 'tu1', name: 'echo', input: { msg: 'ok' } },
        { type: 'usage', usage: { input_tokens: 189_217, output_tokens: 5 } as ChatUsage },
        { type: 'done', stop_reason: 'tool_use' },
      ]),
      registry: makeRegistry({ echo: () => 'ok' }),
      toolContext: emptyToolContext(),
    });
    ctx.opts.contextWindow = 1_000_000;
    ctx.bridge = {
      peekMilestoneCompaction: () => 'milestone:error-resolved',
    };
    // Reproduces the old >=12-message shortcut without making the prompt large.
    ctx.messages = Array.from({ length: 12 }, (_, i): AgentMessage => ({
      role: 'user',
      content: [{ type: 'text', text: `small message ${i}` }],
    }));

    const event = await new ExecutingNode().execute(ctx, null);

    expect(event.kind).toBe('TurnSucceeded');
  });

  it('uses a queued milestone only after a real size gate fires', async () => {
    const { ctx } = makeTestContext({
      provider: makeStreamingProvider([
        { type: 'tool_call_start', id: 'tu1', name: 'echo' },
        { type: 'tool_call_end', id: 'tu1', name: 'echo', input: { msg: 'ok' } },
        { type: 'usage', usage: { input_tokens: 960_000, output_tokens: 5 } as ChatUsage },
        { type: 'done', stop_reason: 'tool_use' },
      ]),
      registry: makeRegistry({ echo: () => 'ok' }),
      toolContext: emptyToolContext(),
    });
    ctx.opts.contextWindow = 1_000_000;
    ctx.bridge = {
      peekMilestoneCompaction: () => 'milestone:task-closed',
    };

    const event = await new ExecutingNode().execute(ctx, null);

    expect(event).toMatchObject({
      kind: 'TokenThresholdHit',
      trigger: 'milestone:task-closed',
    });
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
    expect(recordedEvents.find(e => e.event === 'message_complete')?.args[3]).toEqual({
      prompt_tokens: 1000, source: 'usage', context_window: payload.context_window,
    });
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
    expect(recordedEvents.find(e => e.event === 'message_complete')?.args[3]).toMatchObject({
      prompt_tokens: payload.prompt_tokens, source: 'estimate',
    });
  });

  it('continues after repeated authorized local mutations', async () => {
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

    expect(event.kind).toBe('TurnSucceeded');
    const lastMsg = ctx.messages.at(-1);
    expect(lastMsg?.role).toBe('tool');
    expect(JSON.stringify(lastMsg?.content)).toContain('pong');
    expect(JSON.stringify(lastMsg?.content)).not.toMatch(/loop-refused/);
  });

  it('continues after the fifth failure and delivers its original details', async () => {
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

    expect(event.kind).toBe('TurnSucceeded');
    expect(ctx.failureStreaks.streaks.get('write_stdin')?.consecutive).toBe(5);

    // The original actionable error remains visible.
    const lastMsg = ctx.messages.at(-1);
    expect(JSON.stringify(lastMsg?.content)).toContain('session not active');
    expect(JSON.stringify(lastMsg?.content)).not.toMatch(/failure-streak REFUSED/);

    // The runner emitted a tool_loop_intervention event tagged
    // 'failure-streak' so the dashboard sees the banner.
    const intervention = recordedEvents.find((e) => e.event === 'tool_loop_intervention');
    expect(intervention).toBeDefined();
    const payload = intervention?.args[0] as { kind?: string; severity?: string };
    expect(payload?.kind).toBe('failure-streak');
    expect(payload?.severity).toBe('informational');
  });

  it('observes tool dominance without redirecting a productive turn', async () => {
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
    // Seven prior silent read_file turns; this turn fills the fixed 8-slot
    // product window with no assistant text → grind detected.
    ctx.dominance.window = Array.from({ length: 7 }, () => ({
      name: 'read_file',
      hadText: false,
    }));
    const event = await new ExecutingNode().execute(ctx, null);
    expect(event.kind).toBe('TurnSucceeded');
    const intervention = recordedEvents.find((e) => e.event === 'tool_loop_intervention');
    expect((intervention?.args[0] as { kind?: string })?.kind).toBe('dominance');
    expect(ctx.dominance.window).toHaveLength(0); // reset on fire
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
    ctx.dominance.window = Array.from({ length: 7 }, () => ({
      name: 'read_file',
      hadText: false,
    }));
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
    const recordProviderAttempt = vi.fn();
    ctx.opts.sessionStore = { recordProviderAttempt } as never;

    const event = await new ExecutingNode().execute(ctx, null);

    expect(event.kind).toBe('ProviderError');
    expect(recordProviderAttempt).toHaveBeenCalledTimes(1);
    expect(recordProviderAttempt).toHaveBeenCalledWith(expect.objectContaining({
      attempt: 1,
      ok: false,
      status: 429,
      error_code: 'provider_chat_threw',
      error_message: 'Error',
    }));
    if (event.kind === 'ProviderError') {
      expect(event.status).toBe(429);
      expect(event.retryable).toBe(true);
    }
  });

  it('treats provider EOF without done as a failed physical attempt', async () => {
    const { ctx } = makeTestContext({
      provider: makeStreamingProvider([
        { type: 'text_delta', text: 'partial response' },
      ]),
      registry: makeRegistry({}),
      toolContext: emptyToolContext(),
    });
    const recordProviderAttempt = vi.fn();
    ctx.opts.sessionStore = { recordProviderAttempt } as never;

    const event = await new ExecutingNode().execute(ctx, null);

    expect(event).toMatchObject({
      kind: 'ProviderError',
      retryable: true,
      status: 502,
      code: 'stream_ended_no_result',
    });
    expect(recordProviderAttempt).toHaveBeenCalledTimes(1);
    expect(recordProviderAttempt).toHaveBeenCalledWith(expect.objectContaining({
      attempt: 1,
      ok: false,
      status: 502,
      error_code: 'stream_ended_no_result',
      error_message: 'ProviderStreamProtocolError',
    }));
    expect(ctx.messages).not.toContainEqual(expect.objectContaining({ role: 'assistant' }));
  });

  it('retries a terminal provider response with no text or tool call', async () => {
    const { ctx } = makeTestContext({
      provider: makeStreamingProvider([
        { type: 'usage', usage: { input_tokens: 0, output_tokens: 0 } as ChatUsage },
        { type: 'done', stop_reason: 'stop' },
      ]),
      registry: makeRegistry({}),
      toolContext: emptyToolContext(),
    });
    const recordProviderAttempt = vi.fn();
    ctx.opts.sessionStore = { recordProviderAttempt } as never;

    const event = await new ExecutingNode().execute(ctx, null);

    expect(event).toMatchObject({
      kind: 'ProviderError',
      retryable: true,
      status: 502,
      code: 'provider_empty_result',
    });
    expect(recordProviderAttempt).toHaveBeenCalledWith(expect.objectContaining({
      ok: false,
      status: 502,
      error_code: 'provider_empty_result',
      error_message: 'ProviderStreamProtocolError',
    }));
    expect(ctx.stopReason).not.toBe('completed');
    expect(ctx.messages).not.toContainEqual(expect.objectContaining({ role: 'assistant' }));
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

  it('returns promptly on cancel even when iterator next and return never settle', async () => {
    const controller = new AbortController();
    const close = vi.fn(() => new Promise<IteratorResult<ChatDelta>>(() => {}));
    const cancelStream = vi.fn();
    const stream = { [Symbol.asyncIterator]: () => ({
      next: () => new Promise<IteratorResult<ChatDelta>>(() => {}), return: close,
    }) };
    const pending = consumeStream({ stream, signal: controller.signal, cancelStream });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'ABORTED' });
    expect(cancelStream).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  it('cancels transport on an idle timeout without awaiting a stuck iterator return', async () => {
    const close = vi.fn(() => new Promise<IteratorResult<ChatDelta>>(() => {}));
    const cancelStream = vi.fn();
    const stream = { [Symbol.asyncIterator]: () => ({
      next: () => new Promise<IteratorResult<ChatDelta>>(() => {}), return: close,
    }) };
    await expect(consumeStream({ stream, firstByteTimeoutMs: 1, cancelStream })).rejects.toMatchObject({ code: 'TIMEOUT' });
    expect(cancelStream).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  it('retracts a mid-stream failure so the retry does not stack on the discarded attempt', async () => {
    // Nothing streamed here reaches `assistantContent`, and Recovering sends
    // the SAME transcript back — so the retry re-reasons and produces a
    // near-identical summary. Without the retraction the user sees both.
    const { ctx, recordedEvents } = makeTestContext({
      provider: {
        name: 'mock',
        model: 'claude-haiku-4-5-20251001',
        setModel() {},
        async *chat(): AsyncIterable<ChatDelta> {
          yield { type: 'thinking_delta', text: 'Analyzing' };
          yield { type: 'thinking_delta', text: ' the installer' };
          yield { type: 'text_delta', text: 'Partial' };
          throw new Error('connection reset mid-stream');
        },
      } as ChatProvider,
      registry: makeRegistry({}),
      toolContext: emptyToolContext(),
    });

    const event = await new ExecutingNode().execute(ctx, null);

    expect(event.kind).toBe('ProviderError');
    expect(recordedEvents).toContainEqual(expect.objectContaining({
      event: 'stream_rollback',
      args: [expect.objectContaining({
        thinkingChars: 'Analyzing the installer'.length,
        textChars: 'Partial'.length,
      })],
    }));
    // The premise of the retraction: none of it was persisted.
    expect(ctx.messages).not.toContainEqual(expect.objectContaining({ role: 'assistant' }));
  });

  it('does not retract on abort — the partial answer is what the user stopped to read', async () => {
    const abort = new AbortController();
    const { ctx, recordedEvents } = makeTestContext({
      provider: {
        name: 'mock',
        model: 'claude-haiku-4-5-20251001',
        setModel() {},
        async *chat(): AsyncIterable<ChatDelta> {
          yield { type: 'thinking_delta', text: 'partial reasoning' };
          // Let consumeStream observe the signal rather than throwing from the
          // generator — a throw here escapes as an unhandled rejection once
          // consumeStream stops pulling.
          abort.abort();
          yield { type: 'thinking_delta', text: 'never rendered' };
        },
      } as ChatProvider,
      registry: makeRegistry({}),
      toolContext: { ...emptyToolContext(), signal: abort.signal },
    });

    const event = await new ExecutingNode().execute(ctx, null);

    // Deltas WERE streamed, so this proves the abort branch returns ahead of
    // the retraction rather than the counters simply being zero.
    expect(event.kind).toBe('Aborted');
    expect(recordedEvents.map((e) => e.event)).not.toContain('stream_rollback');
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

  it('preserves native public phases and infers them for legacy wires', async () => {
    async function* nativeCommentary(): AsyncIterable<ChatDelta> {
      yield {
        type: 'text_delta',
        text: 'Checking now.',
        itemId: 'msg_1',
        phase: 'commentary',
      };
      yield { type: 'tool_call_start', id: 'call_1', name: 'read_file' };
      yield { type: 'tool_call_end', id: 'call_1', name: 'read_file', input: {} };
      yield { type: 'done', stop_reason: 'tool_use' };
    }
    const seen: unknown[] = [];
    const commentary = await consumeStream({
      stream: nativeCommentary(),
      onTextDelta: (text, meta) => seen.push({ text, meta }),
    });
    expect(commentary.messagePhase).toBe('commentary');
    expect(seen).toEqual([{
      text: 'Checking now.',
      meta: { itemId: 'msg_1', phase: 'commentary' },
    }]);

    async function* legacyFinal(): AsyncIterable<ChatDelta> {
      yield { type: 'text_delta', text: 'Done.' };
      yield { type: 'done', stop_reason: 'stop' };
    }
    await expect(consumeStream({ stream: legacyFinal() }))
      .resolves.toMatchObject({ messagePhase: 'final_answer' });
  });

  it('rejects a clean iterator EOF that lacks the terminal result event', async () => {
    async function* truncated(): AsyncIterable<ChatDelta> {
      yield { type: 'text_delta', text: 'partial' };
    }

    await expect(consumeStream({
      stream: truncated(),
      idleTimeoutMs: 1_000,
      firstByteTimeoutMs: 1_000,
    })).rejects.toMatchObject({
      name: 'ProviderStreamProtocolError',
      status: 502,
      code: 'stream_ended_no_result',
    });
  });

  it('rejects a terminal result that contains only usage metadata', async () => {
    async function* emptyTerminal(): AsyncIterable<ChatDelta> {
      yield { type: 'usage', usage: { input_tokens: 0, output_tokens: 0 } as ChatUsage };
      yield { type: 'done', stop_reason: 'stop' };
    }

    await expect(consumeStream({ stream: emptyTerminal() })).rejects.toMatchObject({
      name: 'ProviderStreamProtocolError',
      status: 502,
      code: 'provider_empty_result',
    });
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
