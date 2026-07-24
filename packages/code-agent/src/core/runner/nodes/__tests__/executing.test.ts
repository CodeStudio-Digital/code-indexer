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
import { ToolCallLedger } from '@mcp/code-agent/core/tool-call-ledger.js';
import { goalTools } from '@mcp/code-agent/tools/goal.js';
import { ExecutingNode } from '../executing.js';
import { consumeStream, thinkingOnlyBudgetMs } from '../executing-stream.js';
import { makeTestContext } from './test-helpers.js';
import { deriveTokenLimits } from '@mcp/code-agent/core/compaction/limits.js';
import { HookBus, type HookDefinition } from '@mcp/code-agent/core/hook-bus.js';

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
    ctx.transientRetriesThisTurn = 2;

    const event = await new ExecutingNode().execute(ctx, null);

    expect(event.kind).toBe('CleanFinish');
    expect(ctx.stopReason).toBe('completed');
    // Assistant message landed in history.
    expect(ctx.messages.at(-1)?.role).toBe('assistant');
    expect(ctx.turn).toBe(1);
    expect(ctx.transientRetriesThisTurn).toBe(0);
  });

  it('restores protected goal transitions omitted by a post-build selector', async () => {
    const visibleNames: string[] = [];
    const { ctx } = makeTestContext({
      provider: makeStreamingProvider(
        [
          { type: 'text_delta', text: 'done' },
          { type: 'done', stop_reason: 'end_turn' },
        ],
        (request) => visibleNames.push(...request.tools.map((tool) => tool.name)),
      ),
      registry: makeRegistry({
        create_goal: () => 'created',
        read_file: () => 'read',
        update_goal: () => 'completed',
      }),
      toolContext: emptyToolContext(),
    });
    ctx.opts.toolSelectionFilter = async (tools) =>
      tools.filter((tool) => tool.name === 'create_goal');

    expect((await new ExecutingNode().execute(ctx, null)).kind).toBe('CleanFinish');
    expect(visibleNames).toContain('create_goal');
    expect(visibleNames).toContain('update_goal');
  });

  it('blocks a hallucinated create_goal when update_goal is unavailable even with pinning off', async () => {
    vi.stubEnv('CODER_TOOL_PIN_DISABLE', '1');
    let createCalls = 0;
    const { ctx } = makeTestContext({
      provider: makeStreamingProvider([
        { type: 'tool_call_start', id: 'tu-create', name: 'create_goal' },
        {
          type: 'tool_call_end',
          id: 'tu-create',
          name: 'create_goal',
          input: { goal: 'Unclosable objective' },
        },
        { type: 'done', stop_reason: 'tool_use' },
      ]),
      registry: makeRegistry({
        create_goal: () => {
          createCalls += 1;
          return 'created';
        },
        update_goal: () => 'completed',
      }),
      toolContext: emptyToolContext(),
    });
    ctx.opts.sessionDisabledTools = new Set(['update_goal']);

    try {
      expect((await new ExecutingNode().execute(ctx, null)).kind).toBe('TurnSucceeded');
      expect(createCalls).toBe(0);
      expect(JSON.stringify(ctx.messages.at(-1)?.content))
        .toContain('[goal-lifecycle-disabled]');
      expect(ctx.pinnedTools.has('create_goal')).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('nudges once before a text-only finish when writes lack fresh verification', async () => {
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
    ledger.record({
      name: 'edit_file',
      args: { path: 'src/a.ts' },
      content: 'edited',
      isError: false,
      mutates: true,
      executionClass: 'write',
    });
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
    ctx.opts.verificationEvidenceEnabled = true;
    ctx.bridge = {
      getSessionStateData: () => ({
        goal: null,
        activePlan: null,
        todos: [],
        notes: [],
        filesChanged: ['src/a.ts'],
        investigationCount: 0,
      }),
    };

    const first = await new ExecutingNode().execute(ctx, null);
    expect(first).toEqual({ kind: 'TurnSucceeded', hasToolCalls: false });
    expect(ctx.messages.at(-1)?.role).toBe('user');
    expect(JSON.stringify(ctx.messages.at(-1)?.content)).toContain('Completion evidence is not fresh');

    const second = await new ExecutingNode().execute(ctx, first);
    expect(second.kind).toBe('CleanFinish');
    expect(ctx.stopReason).toBe('completed');
    expect(ctx.verification.nudges).toBe(1);
  });

  it('re-enters execution instead of clean-finishing substantive work without a goal', async () => {
    const ledger = new ToolCallLedger();
    const { ctx } = makeTestContext({
      provider: makeSequencedProvider([
        [
          { type: 'tool_call_start', id: 'tu-read', name: 'read_file' },
          {
            type: 'tool_call_end',
            id: 'tu-read',
            name: 'read_file',
            input: { path: 'src/index.ts' },
          },
          { type: 'tool_call_start', id: 'tu-read-2', name: 'read_file' },
          {
            type: 'tool_call_end',
            id: 'tu-read-2',
            name: 'read_file',
            input: { path: 'src/runner.ts' },
          },
          { type: 'tool_call_start', id: 'tu-read-3', name: 'read_file' },
          {
            type: 'tool_call_end',
            id: 'tu-read-3',
            name: 'read_file',
            input: { path: 'src/store.ts' },
          },
          { type: 'done', stop_reason: 'tool_use' },
        ],
        [
          { type: 'text_delta', text: 'The investigation is complete.' },
          { type: 'done', stop_reason: 'end_turn' },
        ],
      ]),
      registry: makeRegistry({
        create_goal: () => 'Goal set',
        read_file: () => 'novel source',
        update_goal: () => 'Goal marked complete',
      }),
      toolContext: {
        ...emptyToolContext(),
        toolCallLedger: ledger,
        getGoalState: () => null,
      } as ToolContext,
    });
    const node = new ExecutingNode();

    expect((await node.execute(ctx, null)).kind).toBe('TurnSucceeded');
    const finishAttempt = await node.execute(ctx, null);

    expect(finishAttempt.kind).toBe('TurnSucceeded');
    expect(ctx.stopReason).toBeNull();
    const reminder = ctx.messages.at(-1);
    expect(reminder?.role).toBe('user');
    expect(JSON.stringify(reminder?.content)).toContain('create_goal');
    expect(JSON.stringify(reminder?.content)).toContain('SAME assistant tool-call batch');
  });

  it('terminates as an error instead of completed after the bounded goal nudges are exhausted', async () => {
    const ledger = new ToolCallLedger();
    const { ctx } = makeTestContext({
      provider: makeSequencedProvider([
        [
          { type: 'text_delta', text: 'Done without a goal.' },
          { type: 'done', stop_reason: 'end_turn' },
        ],
        [
          { type: 'text_delta', text: 'Still done without a goal.' },
          { type: 'done', stop_reason: 'end_turn' },
        ],
        [
          { type: 'text_delta', text: 'Trying to finish anyway.' },
          { type: 'done', stop_reason: 'end_turn' },
        ],
      ]),
      registry: makeRegistry({
        create_goal: () => 'Goal set',
        edit_file: () => 'updated',
        update_goal: () => 'Goal marked complete',
      }),
      toolContext: {
        ...emptyToolContext(),
        toolCallLedger: ledger,
        getGoalState: () => null,
      } as ToolContext,
    });
    ledger.record({
      name: 'edit_file',
      args: { path: 'src/index.ts' },
      content: 'updated',
      isError: false,
      mutates: true,
      executionClass: 'write',
    });
    const node = new ExecutingNode();

    expect((await node.execute(ctx, null)).kind).toBe('TurnSucceeded');
    expect((await node.execute(ctx, null)).kind).toBe('TurnSucceeded');
    const terminal = await node.execute(ctx, null);

    expect(terminal.kind).toBe('Aborted');
    expect(ctx.stopReason).toBe('error');
    expect(ctx.error?.message).toContain('goal_lifecycle_violation');
    expect(ctx.stopReason).not.toBe('completed');
  });

  it('supports create_goal, work, then update_goal in the same assistant tool-call batch', async () => {
    type GoalSnapshot = NonNullable<ReturnType<NonNullable<ToolContext['getGoalState']>>>;
    let goal: GoalSnapshot | null = null;
    let editCalls = 0;
    const persistedStatuses: GoalSnapshot['status'][] = [];
    const persistedAttributions: Array<{
      toolUseId: string;
      toolName: 'create_goal' | 'update_goal';
    }> = [];
    const registry = new ToolRegistry();
    registry.registerAll(goalTools);
    registry.register({
      name: 'edit_file',
      description: 'test write',
      parameters: { type: 'object', properties: {} },
      source: 'native',
      mutates: true,
      riskLevel: 'write',
      handler: async () => {
        editCalls += 1;
        return { content: 'updated' };
      },
    });
    const ledger = new ToolCallLedger();
    const { ctx } = makeTestContext({
      provider: makeSequencedProvider([
        [
          { type: 'tool_call_start', id: 'tu-create', name: 'create_goal' },
          {
            type: 'tool_call_end',
            id: 'tu-create',
            name: 'create_goal',
            input: { goal: 'Fix and verify the lifecycle' },
          },
          { type: 'tool_call_start', id: 'tu-edit', name: 'edit_file' },
          {
            type: 'tool_call_end',
            id: 'tu-edit',
            name: 'edit_file',
            input: { path: 'src/index.ts' },
          },
          { type: 'tool_call_start', id: 'tu-complete', name: 'update_goal' },
          {
            type: 'tool_call_end',
            id: 'tu-complete',
            name: 'update_goal',
            input: { status: 'complete', note: 'Verified.' },
          },
          { type: 'done', stop_reason: 'tool_use' },
        ],
        [
          { type: 'text_delta', text: 'Done and verified.' },
          { type: 'done', stop_reason: 'end_turn' },
        ],
      ]),
      registry,
      toolContext: {
        ...emptyToolContext(),
        toolCallLedger: ledger,
        getGoalState: () => goal,
        upsertGoalState: async (next, attribution) => {
          await Promise.resolve();
          goal = {
            ...next,
            budgetTokens: next.budgetTokens ?? null,
            completionNote: next.completionNote ?? null,
          };
          persistedStatuses.push(next.status);
          persistedAttributions.push(attribution);
        },
      } as ToolContext,
    });
    const node = new ExecutingNode();

    expect((await node.execute(ctx, null)).kind).toBe('TurnSucceeded');
    expect(persistedStatuses).toEqual(['in_progress', 'complete']);
    expect(persistedAttributions).toEqual([
      { toolUseId: 'tu-create', toolName: 'create_goal' },
      { toolUseId: 'tu-complete', toolName: 'update_goal' },
    ]);
    expect(editCalls).toBe(1);
    expect((goal as GoalSnapshot | null)?.status).toBe('complete');
    expect((await node.execute(ctx, null)).kind).toBe('CleanFinish');
  });

  it('keeps the durable goal in progress when the independent verifier rejects update_goal', async () => {
    type GoalSnapshot = NonNullable<ReturnType<NonNullable<ToolContext['getGoalState']>>>;
    let goal: GoalSnapshot = {
      text: 'Finish the requested correction',
      status: 'in_progress',
      budgetTokens: null,
      completionNote: null,
      createdAt: '2026-07-23T00:00:00.000Z',
      updatedAt: '2026-07-23T00:00:00.000Z',
    };
    const upsertGoalState = vi.fn((next: GoalSnapshot) => {
      goal = next;
    });
    const registry = new ToolRegistry();
    registry.registerAll(goalTools);
    const { ctx } = makeTestContext({
      provider: makeStreamingProvider([
        { type: 'tool_call_start', id: 'tu-complete-rejected', name: 'update_goal' },
        {
          type: 'tool_call_end',
          id: 'tu-complete-rejected',
          name: 'update_goal',
          input: { status: 'complete', note: 'Claimed complete.' },
        },
        { type: 'done', stop_reason: 'tool_use' },
      ]),
      registry,
      toolContext: {
        ...emptyToolContext(),
        getGoalState: () => goal,
        upsertGoalState,
      } as ToolContext,
    });
    const verifyGoalCompletion = vi.fn(async () => ({
      goalMet: false,
      gaps: [{ description: 'Regression proof is missing', severity: 'high' as const }],
    }));
    ctx.bridge = { verifyGoalCompletion } as never;

    expect((await new ExecutingNode().execute(ctx, null)).kind).toBe('TurnSucceeded');
    expect(verifyGoalCompletion).toHaveBeenCalledTimes(1);
    expect(upsertGoalState).not.toHaveBeenCalled();
    expect(goal.status).toBe('in_progress');
    expect(JSON.stringify(ctx.messages.at(-1)?.content)).toContain('[goal-verifier]');
    expect(JSON.stringify(ctx.messages.at(-1)?.content)).toContain('Regression proof is missing');
  });

  it('supersedes an inherited goal on explicit pivot without asking the completion verifier to lie', async () => {
    type GoalSnapshot = NonNullable<ReturnType<NonNullable<ToolContext['getGoalState']>>>;
    let goal: GoalSnapshot = {
      text: 'Old unfinished objective',
      status: 'in_progress',
      budgetTokens: null,
      completionNote: null,
      createdAt: '2026-07-23T00:00:00.000Z',
      updatedAt: '2026-07-23T00:00:00.000Z',
    };
    const registry = new ToolRegistry();
    registry.registerAll(goalTools);
    const { ctx } = makeTestContext({
      provider: makeStreamingProvider([
        { type: 'tool_call_start', id: 'tu-supersede', name: 'update_goal' },
        {
          type: 'tool_call_end',
          id: 'tu-supersede',
          name: 'update_goal',
          input: {
            status: 'superseded',
            note: 'The user explicitly requested a replacement objective.',
          },
        },
        { type: 'done', stop_reason: 'tool_use' },
      ]),
      registry,
      toolContext: {
        ...emptyToolContext(),
        goalLifecycleIntent: 'required_pivot',
        goalLifecyclePivotGoalCreatedAt: goal.createdAt,
        getGoalState: () => goal,
        upsertGoalState: (next) => {
          goal = {
            ...next,
            budgetTokens: next.budgetTokens ?? null,
            completionNote: next.completionNote ?? null,
          };
        },
      } as ToolContext,
    });
    ctx.opts.goalLifecycleIntent = 'required_pivot';
    const verifyGoalCompletion = vi.fn(async () => ({
      goalMet: false,
      gaps: [{ description: 'Old objective was not completed', severity: 'high' as const }],
    }));
    ctx.bridge = { verifyGoalCompletion } as never;

    expect((await new ExecutingNode().execute(ctx, null)).kind).toBe('TurnSucceeded');
    expect(verifyGoalCompletion).not.toHaveBeenCalled();
    expect(goal.status).toBe('superseded');
    expect(goal.completionNote).toContain('replacement objective');
  });

  it('refuses premature completion, then accepts validation followed by update_goal', async () => {
    type GoalSnapshot = NonNullable<ReturnType<NonNullable<ToolContext['getGoalState']>>>;
    let goal: GoalSnapshot | null = null;
    const persistedStatuses: GoalSnapshot['status'][] = [];
    const registry = new ToolRegistry();
    registry.registerAll(goalTools);
    registry.register({
      name: 'edit_file',
      description: 'test write',
      parameters: { type: 'object', properties: {} },
      source: 'native',
      mutates: true,
      riskLevel: 'write',
      executionClass: 'write',
      handler: async () => ({ content: 'updated' }),
    });
    registry.register({
      name: 'run_command',
      description: 'test validation',
      parameters: { type: 'object', properties: {} },
      source: 'native',
      riskLevel: 'execute',
      executionClass: 'execute',
      handler: async () => ({ content: 'tests passed' }),
    });
    const ledger = new ToolCallLedger();
    const { ctx } = makeTestContext({
      provider: makeSequencedProvider([
        [
          { type: 'tool_call_start', id: 'tu-create', name: 'create_goal' },
          {
            type: 'tool_call_end',
            id: 'tu-create',
            name: 'create_goal',
            input: { goal: 'Fix and validate the lifecycle' },
          },
          { type: 'tool_call_start', id: 'tu-edit', name: 'edit_file' },
          {
            type: 'tool_call_end',
            id: 'tu-edit',
            name: 'edit_file',
            input: { path: 'src/index.ts' },
          },
          { type: 'tool_call_start', id: 'tu-early-complete', name: 'update_goal' },
          {
            type: 'tool_call_end',
            id: 'tu-early-complete',
            name: 'update_goal',
            input: { status: 'complete' },
          },
          { type: 'done', stop_reason: 'tool_use' },
        ],
        [
          { type: 'tool_call_start', id: 'tu-validate', name: 'run_command' },
          {
            type: 'tool_call_end',
            id: 'tu-validate',
            name: 'run_command',
            input: { command: 'pnpm test' },
          },
          { type: 'tool_call_start', id: 'tu-complete', name: 'update_goal' },
          {
            type: 'tool_call_end',
            id: 'tu-complete',
            name: 'update_goal',
            input: { status: 'complete', note: 'Validated.' },
          },
          { type: 'done', stop_reason: 'tool_use' },
        ],
        [
          { type: 'text_delta', text: 'Done and validated.' },
          { type: 'done', stop_reason: 'end_turn' },
        ],
      ]),
      registry,
      toolContext: {
        ...emptyToolContext(),
        toolCallLedger: ledger,
        getGoalState: () => goal,
        upsertGoalState: (next) => {
          goal = {
            ...next,
            budgetTokens: next.budgetTokens ?? null,
            completionNote: next.completionNote ?? null,
          };
          persistedStatuses.push(next.status);
        },
      } as ToolContext,
    });
    ctx.opts.verificationEvidenceEnabled = true;
    ctx.bridge = {
      getSessionStateData: () => ({
        goal: null,
        activePlan: null,
        todos: [],
        notes: [],
        filesChanged: ['src/index.ts'],
        investigationCount: 0,
      }),
    };
    const node = new ExecutingNode();

    expect((await node.execute(ctx, null)).kind).toBe('TurnSucceeded');
    expect(persistedStatuses).toEqual(['in_progress']);
    expect((goal as GoalSnapshot | null)?.status).toBe('in_progress');
    expect(JSON.stringify(ctx.messages.at(-1)?.content))
      .toContain('[verification-evidence]');

    expect((await node.execute(ctx, null)).kind).toBe('TurnSucceeded');
    expect(persistedStatuses).toEqual(['in_progress', 'complete']);
    expect((goal as GoalSnapshot | null)?.status).toBe('complete');

    expect((await node.execute(ctx, null)).kind).toBe('CleanFinish');
  });

  it('refuses update_goal in the same batch when substantive work failed', async () => {
    type GoalSnapshot = NonNullable<ReturnType<NonNullable<ToolContext['getGoalState']>>>;
    let goal: GoalSnapshot | null = null;
    const persistedStatuses: GoalSnapshot['status'][] = [];
    const registry = new ToolRegistry();
    registry.registerAll(goalTools);
    registry.register({
      name: 'edit_file',
      description: 'failing test write',
      parameters: { type: 'object', properties: {} },
      source: 'native',
      mutates: true,
      riskLevel: 'write',
      handler: async () => ({ content: 'old string not found', isError: true }),
    });
    const ledger = new ToolCallLedger();
    const { ctx } = makeTestContext({
      provider: makeStreamingProvider([
        { type: 'tool_call_start', id: 'tu-create', name: 'create_goal' },
        {
          type: 'tool_call_end',
          id: 'tu-create',
          name: 'create_goal',
          input: { goal: 'Fix the failing edit' },
        },
        { type: 'tool_call_start', id: 'tu-edit', name: 'edit_file' },
        {
          type: 'tool_call_end',
          id: 'tu-edit',
          name: 'edit_file',
          input: { path: 'src/index.ts' },
        },
        { type: 'tool_call_start', id: 'tu-complete', name: 'update_goal' },
        {
          type: 'tool_call_end',
          id: 'tu-complete',
          name: 'update_goal',
          input: { status: 'complete' },
        },
        { type: 'done', stop_reason: 'tool_use' },
      ]),
      registry,
      toolContext: {
        ...emptyToolContext(),
        toolCallLedger: ledger,
        getGoalState: () => goal,
        upsertGoalState: (next) => {
          goal = {
            ...next,
            budgetTokens: next.budgetTokens ?? null,
            completionNote: next.completionNote ?? null,
          };
          persistedStatuses.push(next.status);
        },
      } as ToolContext,
    });

    expect((await new ExecutingNode().execute(ctx, null)).kind).toBe('TurnSucceeded');
    expect(persistedStatuses).toEqual(['in_progress']);
    expect((goal as GoalSnapshot | null)?.status).toBe('in_progress');
    expect(JSON.stringify(ctx.messages.at(-1)?.content)).toContain(
      'required work is still unresolved',
    );
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
