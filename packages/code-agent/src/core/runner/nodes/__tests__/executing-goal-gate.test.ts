import { describe, expect, it } from 'vitest';
import { ToolRegistry } from '@mcp/code-agent/core/registry.js';
import { ToolCallLedger } from '@mcp/code-agent/core/tool-call-ledger.js';
import type { CoderTool, ToolContext } from '@mcp/code-agent/core/tool.js';
import {
  evaluateGoalLifecycleAtFinish,
  goalLifecycleRefusalBeforeTool,
} from '../executing-goal-gate.js';
import { makeTestContext } from './test-helpers.js';

type GoalSnapshot = NonNullable<ReturnType<NonNullable<ToolContext['getGoalState']>>>;

function registerTool(
  registry: ToolRegistry,
  name: string,
  metadata: Partial<Pick<
    CoderTool,
    'mutates' | 'riskLevel' | 'executionClass' | 'source' | 'riskOf'
  >> = {},
): void {
  registry.register({
    name,
    description: `test ${name}`,
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    source: 'native',
    ...metadata,
    handler: async () => ({ content: 'ok' }),
  });
}

function activeGoal(status: GoalSnapshot['status'] = 'in_progress'): GoalSnapshot {
  return {
    text: 'Fix and verify the requested behavior',
    status,
    budgetTokens: null,
    completionNote: null,
    createdAt: '2026-07-23T00:00:00.000Z',
    updatedAt: '2026-07-23T00:00:00.000Z',
  };
}

function harness(initialGoal: GoalSnapshot | null = null): {
  ctx: ReturnType<typeof makeTestContext>['ctx'];
  ledger: ToolCallLedger;
  registry: ToolRegistry;
  setGoal: (next: GoalSnapshot | null) => void;
} {
  const ledger = new ToolCallLedger();
  const registry = new ToolRegistry();
  registerTool(registry, 'create_goal', { mutates: false, riskLevel: 'read' });
  registerTool(registry, 'update_goal', { mutates: false, riskLevel: 'read' });
  let goal = initialGoal;
  const { ctx } = makeTestContext({
    registry,
    toolContext: {
      cwd: process.cwd(),
      projectName: 'goal-gate-test',
      toolCallLedger: ledger,
      getGoalState: () => goal,
    } as ToolContext,
  });
  return {
    ctx,
    ledger,
    registry,
    setGoal: (next) => {
      goal = next;
    },
  };
}

describe('evaluateGoalLifecycleAtFinish', () => {
  it('allows a conversational turn with no current-run work evidence', () => {
    const { ctx } = harness();
    expect(evaluateGoalLifecycleAtFinish(ctx)).toBeNull();
  });

  it('requires a goal before a fresh actionable objective can finish in prose', () => {
    const { ctx } = harness();
    ctx.opts.goalLifecycleIntent = 'required_fresh';

    expect(evaluateGoalLifecycleAtFinish(ctx)).toMatchObject({
      kind: 'nudge',
      phase: 'missing',
    });
  });

  it('requires completion when an actionable objective resumes with an active goal', () => {
    const { ctx } = harness(activeGoal());
    ctx.opts.goalLifecycleIntent = 'required_resume';

    expect(evaluateGoalLifecycleAtFinish(ctx)).toMatchObject({
      kind: 'nudge',
      phase: 'in_progress',
    });
  });

  it('does not let an inherited completed goal satisfy a fresh actionable objective', () => {
    const { ctx } = harness(activeGoal('complete'));
    ctx.opts.goalLifecycleIntent = 'required_fresh';

    expect(evaluateGoalLifecycleAtFinish(ctx)).toMatchObject({
      kind: 'nudge',
      phase: 'missing',
    });
  });

  it('allows a resumed objective after update_goal succeeds in this run', () => {
    const { ctx, ledger } = harness(activeGoal('complete'));
    ctx.opts.goalLifecycleIntent = 'required_resume';
    ledger.record({
      name: 'update_goal',
      args: { status: 'complete' },
      content: 'Goal marked complete',
      isError: false,
    });

    expect(evaluateGoalLifecycleAtFinish(ctx)).toBeNull();
  });

  it('refuses goal completion while background agents still have unresolved outcomes', () => {
    const { ctx } = harness(activeGoal());
    ctx.bridge = {
      backgroundJobs: {
        hasActive: () => true,
        hasUncollectedTerminal: () => false,
        park: async () => 'work',
      },
    };

    expect(goalLifecycleRefusalBeforeTool(
      ctx,
      'update_goal',
      { status: 'complete' },
      { effectiveToolNames: new Set(['create_goal', 'update_goal', 'collect_agents']) },
    )).toContain('background agent outcomes');

    expect(goalLifecycleRefusalBeforeTool(
      ctx,
      'update_goal',
      { status: 'superseded', note: 'user changed objective' },
      { effectiveToolNames: new Set(['create_goal', 'update_goal']) },
    )).not.toContain('background agent outcomes');
  });

  it('refuses goal completion after notification until terminal results are collected', () => {
    const { ctx } = harness(activeGoal());
    ctx.bridge = {
      backgroundJobs: {
        hasActive: () => false,
        hasUncollectedTerminal: () => true,
        park: async () => 'work',
      },
    };

    expect(goalLifecycleRefusalBeforeTool(
      ctx,
      'update_goal',
      { status: 'complete' },
      { effectiveToolNames: new Set(['create_goal', 'update_goal', 'collect_agents']) },
    )).toContain('have not been collected in full');
  });

  it('does not let closing an inherited goal satisfy a fresh objective', () => {
    const { ctx, ledger } = harness(activeGoal('complete'));
    ctx.opts.goalLifecycleIntent = 'required_fresh';
    ledger.record({
      name: 'update_goal',
      args: { status: 'complete' },
      content: 'Inherited goal marked complete',
      isError: false,
    });

    expect(evaluateGoalLifecycleAtFinish(ctx)).toMatchObject({
      kind: 'nudge',
      phase: 'missing',
    });

    ledger.record({
      name: 'create_goal',
      args: { goal: 'Fresh objective' },
      content: 'Goal set',
      isError: false,
    });
    ledger.record({
      name: 'update_goal',
      args: { status: 'complete' },
      content: 'Fresh goal marked complete',
      isError: false,
    });
    expect(evaluateGoalLifecycleAtFinish(ctx)).toBeNull();
  });

  it('still skips intent enforcement when the exact tool surface lacks the goal pair', () => {
    const { ctx } = harness();
    ctx.opts.goalLifecycleIntent = 'required_fresh';

    expect(evaluateGoalLifecycleAtFinish(ctx, {
      effectiveToolNames: new Set(['read_file']),
    })).toBeNull();
  });

  it('does not demand goal tools from a role-filtered catalog without them', () => {
    const ledger = new ToolCallLedger();
    const registry = new ToolRegistry();
    registerTool(registry, 'edit_file', { mutates: true, riskLevel: 'write' });
    const { ctx } = makeTestContext({
      registry,
      toolContext: {
        cwd: process.cwd(),
        projectName: 'goal-gate-test',
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
    });

    expect(evaluateGoalLifecycleAtFinish(ctx)).toBeNull();
  });

  it('does not demand a goal tool disabled for this session', () => {
    const { ctx, ledger, registry } = harness();
    registerTool(registry, 'edit_file', { mutates: true, riskLevel: 'write' });
    ctx.opts.sessionDisabledTools = new Set(['create_goal']);
    ledger.record({
      name: 'edit_file',
      args: { path: 'src/index.ts' },
      content: 'updated',
      isError: false,
      mutates: true,
    });

    expect(evaluateGoalLifecycleAtFinish(ctx)).toBeNull();
  });

  it('does not demand a goal tool disabled globally by administration', () => {
    const { ctx, ledger, registry } = harness();
    registerTool(registry, 'edit_file', { mutates: true, riskLevel: 'write' });
    ctx.opts.globalDisabledTools = new Set(['update_goal']);
    ledger.record({
      name: 'edit_file',
      args: { path: 'src/index.ts' },
      content: 'updated',
      isError: false,
      mutates: true,
    });

    expect(evaluateGoalLifecycleAtFinish(ctx)).toBeNull();
  });

  it('allows one productive read for a simple factual lookup', () => {
    const { ctx, ledger, registry } = harness();
    registerTool(registry, 'read_file', { mutates: false, riskLevel: 'read' });
    ledger.record({
      name: 'read_file',
      args: { path: 'src/index.ts' },
      content: 'novel source',
      isError: false,
    });

    expect(evaluateGoalLifecycleAtFinish(ctx)).toBeNull();
  });

  it('allows a normal two-step search/read factual lookup', () => {
    const { ctx, ledger, registry } = harness();
    registerTool(registry, 'read_file', { mutates: false, riskLevel: 'read' });
    ledger.record({
      name: 'read_file',
      args: { path: 'src/index.ts' },
      content: 'novel source',
      isError: false,
    });
    ledger.record({
      name: 'read_file',
      args: { path: 'src/runner.ts' },
      content: 'second novel source',
      isError: false,
    });

    expect(evaluateGoalLifecycleAtFinish(ctx)).toBeNull();
  });

  it('requires create_goal after three productive current-run reads', () => {
    const { ctx, ledger, registry } = harness();
    registerTool(registry, 'read_file', { mutates: false, riskLevel: 'read' });
    for (const [index, path] of ['src/index.ts', 'src/runner.ts', 'src/store.ts'].entries()) {
      ledger.record({
        name: 'read_file',
        args: { path },
        content: `novel source ${index}`,
        isError: false,
      });
    }

    const decision = evaluateGoalLifecycleAtFinish(ctx);
    expect(decision).toMatchObject({ kind: 'nudge', phase: 'missing' });
    expect(decision?.kind === 'nudge' ? decision.text : '').toContain(
      'create_goal` first',
    );
    expect(decision?.kind === 'nudge' ? decision.text : '').toContain(
      'SAME assistant tool-call batch',
    );
  });

  it('ignores substantive ledger history from before this run', () => {
    const ledger = new ToolCallLedger();
    ledger.record({
      name: 'read_file',
      args: { path: 'old.ts' },
      content: 'historical result',
      isError: false,
    });
    const registry = new ToolRegistry();
    registerTool(registry, 'create_goal', { mutates: false, riskLevel: 'read' });
    registerTool(registry, 'update_goal', { mutates: false, riskLevel: 'read' });
    registerTool(registry, 'read_file', { mutates: false, riskLevel: 'read' });
    const { ctx } = makeTestContext({
      registry,
      toolContext: {
        cwd: process.cwd(),
        projectName: 'goal-gate-test',
        toolCallLedger: ledger,
        getGoalState: () => null,
      } as ToolContext,
    });

    expect(evaluateGoalLifecycleAtFinish(ctx)).toBeNull();
  });

  it('requires create_goal after update_goal fails because no goal exists', () => {
    const { ctx, ledger } = harness();
    ledger.record({
      name: 'update_goal',
      args: { status: 'complete' },
      content: 'No goal set',
      isError: true,
    });

    expect(evaluateGoalLifecycleAtFinish(ctx)).toMatchObject({
      kind: 'nudge',
      phase: 'missing',
    });
  });

  it('does not clean-finish when create_goal itself failed', () => {
    const { ctx, ledger } = harness();
    ledger.record({
      name: 'create_goal',
      args: { goal: 'Fix it' },
      content: 'create_goal: failed to persist goal state',
      isError: true,
    });

    expect(evaluateGoalLifecycleAtFinish(ctx)).toMatchObject({
      kind: 'nudge',
      phase: 'missing',
    });
  });

  it('fails closed when persisted goal state cannot be read after substantive work', () => {
    const { ctx, ledger, registry } = harness();
    registerTool(registry, 'edit_file', { mutates: true, riskLevel: 'write' });
    ctx.opts.toolContext.getGoalState = () => {
      throw new Error('SQLITE_BUSY');
    };
    ledger.record({
      name: 'edit_file',
      args: { path: 'src/index.ts' },
      content: 'updated',
      isError: false,
      mutates: true,
    });

    expect(evaluateGoalLifecycleAtFinish(ctx)).toMatchObject({
      kind: 'violation',
      phase: 'unavailable',
      message: expect.stringContaining('SQLITE_BUSY'),
    });
  });

  it('allows a status-only turn with an existing untouched goal', () => {
    const { ctx } = harness(activeGoal());
    expect(evaluateGoalLifecycleAtFinish(ctx)).toBeNull();
  });

  it('requires update_goal when create_goal succeeded in this run', () => {
    const { ctx, ledger, setGoal } = harness();
    ledger.record({
      name: 'create_goal',
      args: { goal: 'Fix it' },
      content: 'Goal set',
      isError: false,
    });
    setGoal(activeGoal());

    expect(evaluateGoalLifecycleAtFinish(ctx)).toMatchObject({
      kind: 'nudge',
      phase: 'in_progress',
    });
  });

  it('requires update_goal after substantive work on an active goal', () => {
    const { ctx, ledger, registry } = harness(activeGoal());
    registerTool(registry, 'edit_file', {
      mutates: true,
      riskLevel: 'write',
      executionClass: 'write',
    });
    ledger.record({
      name: 'edit_file',
      args: { path: 'src/index.ts' },
      content: 'updated',
      isError: false,
      mutates: true,
      executionClass: 'write',
    });

    expect(evaluateGoalLifecycleAtFinish(ctx)).toMatchObject({
      kind: 'nudge',
      phase: 'in_progress',
    });
  });

  it('treats a failed execute-class attempt as substantive registry-proven work', () => {
    const { ctx, ledger, registry } = harness();
    registerTool(registry, 'run_command', {
      mutates: false,
      riskLevel: 'execute',
      executionClass: 'execute',
    });
    ledger.record({
      name: 'run_command',
      args: { command: 'test' },
      content: 'failed',
      isError: true,
      executionClass: 'execute',
    });

    expect(evaluateGoalLifecycleAtFinish(ctx)).toMatchObject({
      kind: 'nudge',
      phase: 'missing',
    });
  });

  it('treats one delegated spawn_agent call as high-signal orchestration', () => {
    const { ctx, ledger, registry } = harness();
    registerTool(registry, 'spawn_agent', {
      mutates: false,
      // Proves the explicit orchestration classification rather than relying
      // on the built-in admin fallback for this tool name.
      riskLevel: 'read',
    });
    ledger.record({
      name: 'spawn_agent',
      args: { task: 'audit the stream path' },
      content: 'agent started',
      isError: false,
    });

    expect(evaluateGoalLifecycleAtFinish(ctx)).toMatchObject({
      kind: 'nudge',
      phase: 'missing',
    });
  });

  it('does not classify one read-risk code_exec wrapper as substantive', () => {
    const { ctx, ledger, registry } = harness();
    registerTool(registry, 'code_exec', {
      mutates: false,
      riskLevel: 'read',
      executionClass: 'execute',
    });
    ledger.record({
      name: 'code_exec',
      args: { code: 'return await tools.read_file({path:\"a.ts\"})' },
      content: 'source',
      isError: false,
      executionClass: 'execute',
    });

    expect(evaluateGoalLifecycleAtFinish(ctx)).toBeNull();
  });

  it('does not double-count code_exec around a nested search and read', () => {
    const { ctx, ledger, registry } = harness();
    registerTool(registry, 'code_exec', {
      mutates: false,
      riskLevel: 'read',
      executionClass: 'execute',
    });
    registerTool(registry, 'mcp__search', { mutates: false, riskLevel: 'read' });
    registerTool(registry, 'read_file', { mutates: false, riskLevel: 'read' });
    ledger.record({
      name: 'mcp__search',
      args: { query: 'goal lifecycle' },
      content: 'one match',
      isError: false,
    });
    ledger.record({
      name: 'read_file',
      args: { path: 'src/goal.ts' },
      content: 'source',
      isError: false,
    });
    ledger.record({
      name: 'code_exec',
      args: { code: 'search then read' },
      content: 'combined result',
      isError: false,
      executionClass: 'execute',
    });

    expect(evaluateGoalLifecycleAtFinish(ctx)).toBeNull();
  });

  it('skips enforcement when the post-hook model surface removed a goal tool', () => {
    const { ctx, ledger, registry } = harness();
    registerTool(registry, 'edit_file', { mutates: true, riskLevel: 'write' });
    ledger.record({
      name: 'edit_file',
      args: { path: 'src/index.ts' },
      content: 'updated',
      isError: false,
      mutates: true,
    });

    expect(evaluateGoalLifecycleAtFinish(ctx, {
      effectiveToolNames: new Set(['update_goal', 'edit_file']),
    })).toBeNull();
  });

  it('refuses high-signal work before dispatch until create_goal is active', () => {
    const { ctx, ledger, registry, setGoal } = harness();
    registerTool(registry, 'edit_file', { mutates: true, riskLevel: 'write' });
    const effectiveToolNames = new Set(['create_goal', 'update_goal', 'edit_file']);
    const editInput = { path: 'src/index.ts' };

    expect(goalLifecycleRefusalBeforeTool(ctx, 'edit_file', editInput, { effectiveToolNames }))
      .toContain('Call `create_goal` first');
    expect(ctx.goalLifecycle.preDispatchPending.size).toBe(1);
    setGoal(activeGoal());
    expect(goalLifecycleRefusalBeforeTool(ctx, 'edit_file', editInput, { effectiveToolNames }))
      .toBeNull();
    ledger.record({
      name: 'edit_file',
      args: editInput,
      content: 'updated',
      isError: false,
      mutates: true,
    });
    expect(goalLifecycleRefusalBeforeTool(
      ctx,
      'update_goal',
      { status: 'complete' },
      { effectiveToolNames },
    )).toBeNull();
  });

  it('treats an unannotated external MCP tool as a conservative mutation', () => {
    const { ctx, ledger, registry } = harness();
    registerTool(registry, 'ext__remote__act', { source: 'mcp_external' });
    const effectiveToolNames = new Set([
      'create_goal',
      'update_goal',
      'ext__remote__act',
    ]);

    expect(goalLifecycleRefusalBeforeTool(
      ctx,
      'ext__remote__act',
      { target: 'remote-state' },
      { effectiveToolNames },
    )).toContain('create_goal');

    ledger.record({
      name: 'ext__remote__act',
      args: { target: 'remote-state' },
      content: 'remote action completed',
      isError: false,
      mutates: true,
      riskLevel: 'write',
      executionClass: 'write',
    });
    expect(evaluateGoalLifecycleAtFinish(ctx, { effectiveToolNames }))
      .toMatchObject({ kind: 'nudge', phase: 'missing' });
  });

  it('uses input-sensitive risk for database reads, writes and classifier failure', () => {
    const { ctx, registry } = harness();
    registerTool(registry, 'db_query', {
      mutates: false,
      riskLevel: 'read',
      executionClass: 'read',
      riskOf: (input) => {
        const sql = String((input as { sql?: unknown } | null)?.sql ?? '');
        return /^\s*select\b/i.test(sql) ? 'read' : 'write';
      },
    });
    registerTool(registry, 'broken_dynamic_risk', {
      mutates: false,
      riskLevel: 'read',
      riskOf: () => {
        throw new Error('classifier unavailable');
      },
    });
    const effectiveToolNames = new Set([
      'create_goal',
      'update_goal',
      'db_query',
      'broken_dynamic_risk',
    ]);

    expect(goalLifecycleRefusalBeforeTool(
      ctx,
      'db_query',
      { sql: 'SELECT * FROM sessions' },
      { effectiveToolNames },
    )).toBeNull();
    expect(goalLifecycleRefusalBeforeTool(
      ctx,
      'db_query',
      { sql: 'INSERT INTO sessions(id) VALUES (1)' },
      { effectiveToolNames },
    )).toContain('create_goal');
    expect(goalLifecycleRefusalBeforeTool(
      ctx,
      'broken_dynamic_risk',
      {},
      { effectiveToolNames },
    )).toContain('create_goal');
  });

  it('treats resume_agent as high-signal orchestration at dispatch and finish', () => {
    const { ctx, ledger, registry } = harness();
    registerTool(registry, 'resume_agent');
    const effectiveToolNames = new Set([
      'create_goal',
      'update_goal',
      'resume_agent',
    ]);

    expect(goalLifecycleRefusalBeforeTool(
      ctx,
      'resume_agent',
      { spawn_id: 'spawn-1' },
      { effectiveToolNames },
    )).toContain('create_goal');

    ledger.record({
      name: 'resume_agent',
      args: { spawn_id: 'spawn-1' },
      content: 'resumed one agent',
      isError: false,
    });
    expect(evaluateGoalLifecycleAtFinish(ctx, { effectiveToolNames }))
      .toMatchObject({ kind: 'nudge', phase: 'missing' });
  });

  it('does not attribute a fresh objective to an inherited in-progress goal', () => {
    const { ctx, ledger, registry, setGoal } = harness(activeGoal());
    ctx.opts.goalLifecycleIntent = 'required_fresh';
    registerTool(registry, 'edit_file', { mutates: true, riskLevel: 'write' });
    const effectiveToolNames = new Set(['create_goal', 'update_goal', 'edit_file']);
    const editInput = { path: 'src/new-objective.ts' };

    expect(goalLifecycleRefusalBeforeTool(
      ctx,
      'edit_file',
      editInput,
      { effectiveToolNames },
    )).toContain('active goal belongs to an earlier objective');
    expect(goalLifecycleRefusalBeforeTool(
      ctx,
      'update_goal',
      { status: 'complete' },
      { effectiveToolNames },
    )).toBeNull();

    setGoal(activeGoal('complete'));
    ledger.record({
      name: 'update_goal',
      args: { status: 'complete' },
      content: 'Inherited goal marked complete',
      isError: false,
    });
    setGoal(activeGoal());
    ledger.record({
      name: 'create_goal',
      args: { goal: 'Fresh objective' },
      content: 'Goal set',
      isError: false,
    });

    expect(goalLifecycleRefusalBeforeTool(
      ctx,
      'edit_file',
      editInput,
      { effectiveToolNames },
    )).toBeNull();
    ledger.record({
      name: 'edit_file',
      args: editInput,
      content: 'updated',
      isError: false,
      mutates: true,
    });
    expect(goalLifecycleRefusalBeforeTool(
      ctx,
      'update_goal',
      { status: 'complete' },
      { effectiveToolNames },
    )).toBeNull();
  });

  it('retains goal ownership after create_goal ages out of the bounded ledger', () => {
    const { ctx, ledger, registry, setGoal } = harness();
    ctx.opts.goalLifecycleIntent = 'required_fresh';
    registerTool(registry, 'edit_file', { mutates: true, riskLevel: 'write' });
    const effectiveToolNames = new Set(['create_goal', 'update_goal', 'edit_file']);
    const editInput = { path: 'src/long-running-objective.ts' };

    ledger.record({
      name: 'create_goal',
      args: { goal: 'Complete a long-running objective' },
      content: 'Goal set',
      isError: false,
    });
    setGoal(activeGoal());

    // The first post-create dispatch latches ownership into run state.
    expect(goalLifecycleRefusalBeforeTool(
      ctx,
      'edit_file',
      editInput,
      { effectiveToolNames },
    )).toBeNull();
    expect(ctx.goalLifecycle.createdGoalInRun).toBe(true);

    // ToolCallLedger retains only its latest 500 entries. Reproduce the live
    // failure where a long audit evicted create_goal after 503 calls.
    for (let index = 0; index < 500; index += 1) {
      ledger.record({
        name: 'read_file',
        args: { path: `src/input-${index}.ts` },
        content: `read ${index}`,
        isError: false,
      });
    }
    expect(ledger.snapshot().some((entry) => entry.name === 'create_goal')).toBe(false);

    expect(goalLifecycleRefusalBeforeTool(
      ctx,
      'edit_file',
      editInput,
      { effectiveToolNames },
    )).toBeNull();
  });

  it('allows an explicit pivot to supersede unfinished work without claiming completion', () => {
    const { ctx, ledger, registry, setGoal } = harness(activeGoal());
    ctx.opts.goalLifecycleIntent = 'required_pivot';
    ctx.opts.toolContext.goalLifecyclePivotGoalCreatedAt = activeGoal().createdAt;
    registerTool(registry, 'edit_file', { mutates: true, riskLevel: 'write' });
    const effectiveToolNames = new Set(['create_goal', 'update_goal', 'edit_file']);
    ledger.record({
      name: 'edit_file',
      args: { path: 'src/old-objective.ts' },
      content: 'old objective failed',
      isError: true,
      mutates: true,
      riskLevel: 'write',
      executionClass: 'write',
    });

    expect(goalLifecycleRefusalBeforeTool(
      ctx,
      'update_goal',
      { status: 'superseded', note: 'User changed objective.' },
      { effectiveToolNames },
    )).toBeNull();
    ledger.record({
      name: 'update_goal',
      args: { status: 'superseded', note: 'User changed objective.' },
      content: 'Goal superseded: User changed objective.',
      isError: false,
    });
    setGoal(activeGoal('superseded'));
    expect(evaluateGoalLifecycleAtFinish(ctx, { effectiveToolNames }))
      .toMatchObject({ kind: 'nudge', phase: 'missing' });

    ledger.record({
      name: 'create_goal',
      args: { goal: 'replacement objective' },
      content: 'Goal set',
      isError: false,
    });
    setGoal(activeGoal('in_progress'));
    expect(goalLifecycleRefusalBeforeTool(
      ctx,
      'update_goal',
      { status: 'complete' },
      { effectiveToolNames },
    )).toBeNull();
  });

  it('refuses superseding without a fresh objective authorized by the user', () => {
    const { ctx } = harness(activeGoal());
    ctx.opts.goalLifecycleIntent = 'required_resume';

    expect(goalLifecycleRefusalBeforeTool(
      ctx,
      'update_goal',
      { status: 'superseded', note: 'agent changed its mind' },
      { effectiveToolNames: new Set(['create_goal', 'update_goal']) },
    )).toContain('requires an explicit user pivot');
  });

  it('does not let ordinary fresh-objective authority supersede a goal', () => {
    const { ctx } = harness(activeGoal());
    ctx.opts.goalLifecycleIntent = 'required_fresh';

    expect(goalLifecycleRefusalBeforeTool(
      ctx,
      'update_goal',
      { status: 'superseded', note: 'agent changed its mind' },
      { effectiveToolNames: new Set(['create_goal', 'update_goal']) },
    )).toContain('requires an explicit user pivot');
  });

  it('does not let pivot authority supersede a replacement created in this run', () => {
    const inherited = activeGoal();
    const { ctx, ledger, setGoal } = harness(inherited);
    ctx.opts.goalLifecycleIntent = 'required_pivot';
    ctx.opts.toolContext.goalLifecyclePivotGoalCreatedAt = inherited.createdAt;
    ledger.record({
      name: 'create_goal',
      args: { goal: 'Replacement objective' },
      content: 'Goal set',
      isError: false,
    });
    setGoal({
      ...activeGoal(),
      text: 'Replacement objective',
      createdAt: '2026-07-23T00:01:00.000Z',
      updatedAt: '2026-07-23T00:01:00.000Z',
    });

    expect(goalLifecycleRefusalBeforeTool(
      ctx,
      'update_goal',
      { status: 'superseded', note: 'agent changed its mind again' },
      { effectiveToolNames: new Set(['create_goal', 'update_goal']) },
    )).toContain('never a replacement created in this run');
  });

  it('nudges an explicit pivot to supersede the inherited goal before replacement work', () => {
    const inherited = activeGoal();
    const { ctx } = harness(inherited);
    ctx.opts.goalLifecycleIntent = 'required_pivot';
    ctx.opts.toolContext.goalLifecyclePivotGoalCreatedAt = inherited.createdAt;

    const decision = evaluateGoalLifecycleAtFinish(ctx, {
      effectiveToolNames: new Set(['create_goal', 'update_goal']),
    });
    expect(decision).toMatchObject({ kind: 'nudge', phase: 'in_progress' });
    expect(decision?.kind === 'nudge' ? decision.text : '')
      .toContain('update_goal(status="superseded"');
  });

  it('allows two read results but refuses the third read before dispatch', () => {
    const { ctx, ledger, registry } = harness();
    registerTool(registry, 'read_file', { mutates: false, riskLevel: 'read' });
    const effectiveToolNames = new Set(['create_goal', 'update_goal', 'read_file']);
    for (const path of ['src/index.ts', 'src/runner.ts']) {
      ledger.record({
        name: 'read_file',
        args: { path },
        content: `source ${path}`,
        isError: false,
      });
    }

    expect(goalLifecycleRefusalBeforeTool(
      ctx,
      'read_file',
      { path: 'src/store.ts' },
      { effectiveToolNames },
    ))
      .toContain('no active goal');
  });

  it('does not let unrelated work clear a refused operation before completion', () => {
    const { ctx, ledger, registry, setGoal } = harness();
    registerTool(registry, 'edit_file', { mutates: true, riskLevel: 'write' });
    registerTool(registry, 'run_command', {
      mutates: false,
      riskLevel: 'execute',
      executionClass: 'execute',
    });
    const effectiveToolNames = new Set([
      'create_goal',
      'update_goal',
      'edit_file',
      'run_command',
    ]);
    expect(goalLifecycleRefusalBeforeTool(
      ctx,
      'edit_file',
      { path: 'src/a.ts' },
      { effectiveToolNames },
    )).toContain('Refused');
    setGoal(activeGoal());
    ledger.record({
      name: 'run_command',
      args: { command: 'echo unrelated' },
      content: 'ok',
      isError: false,
      executionClass: 'execute',
    });

    expect(goalLifecycleRefusalBeforeTool(
      ctx,
      'update_goal',
      { status: 'complete' },
      { effectiveToolNames },
    )).toContain('required work is still unresolved');
  });

  it('does not let a success observed before refusal clear the refused retry', () => {
    const { ctx, ledger, registry, setGoal } = harness();
    registerTool(registry, 'edit_file', { mutates: true, riskLevel: 'write' });
    const effectiveToolNames = new Set(['create_goal', 'update_goal', 'edit_file']);
    const editInput = { path: 'src/a.ts' };
    ledger.record({
      name: 'edit_file',
      args: editInput,
      content: 'updated earlier',
      isError: false,
      mutates: true,
    });

    expect(goalLifecycleRefusalBeforeTool(
      ctx,
      'edit_file',
      editInput,
      { effectiveToolNames },
    )).toContain('Refused');
    setGoal(activeGoal());

    expect(goalLifecycleRefusalBeforeTool(
      ctx,
      'update_goal',
      { status: 'complete' },
      { effectiveToolNames },
    )).toContain('required work is still unresolved');

    ledger.record({
      name: 'edit_file',
      args: editInput,
      content: 'updated after goal creation',
      isError: false,
      mutates: true,
    });
    expect(goalLifecycleRefusalBeforeTool(
      ctx,
      'update_goal',
      { status: 'complete' },
      { effectiveToolNames },
    )).toBeNull();
  });

  it('blocks completion after a substantive failure until the operation succeeds', () => {
    const { ctx, ledger, registry } = harness(activeGoal());
    registerTool(registry, 'edit_file', { mutates: true, riskLevel: 'write' });
    const effectiveToolNames = new Set(['create_goal', 'update_goal', 'edit_file']);
    const editInput = { path: 'src/index.ts' };
    ledger.record({
      name: 'edit_file',
      args: editInput,
      content: 'old string not found',
      isError: true,
      mutates: true,
    });

    expect(goalLifecycleRefusalBeforeTool(
      ctx,
      'update_goal',
      { status: 'complete' },
      { effectiveToolNames },
    )).toContain('required work is still unresolved');

    ledger.record({
      name: 'edit_file',
      args: editInput,
      content: 'updated',
      isError: false,
      mutates: true,
    });
    expect(goalLifecycleRefusalBeforeTool(
      ctx,
      'update_goal',
      { status: 'complete' },
      { effectiveToolNames },
    )).toBeNull();
  });

  it('allows resume_agent success to resolve only the matching failed spawn group', () => {
    const { ctx, ledger, registry } = harness(activeGoal());
    registerTool(registry, 'spawn_agent');
    registerTool(registry, 'resume_agent');
    const effectiveToolNames = new Set([
      'create_goal',
      'update_goal',
      'spawn_agent',
      'resume_agent',
    ]);
    ledger.record({
      name: 'spawn_agent',
      args: { task: 'delegated work' },
      content: 'partial',
      isError: true,
      structuredData: {
        kind: 'spawn_agent_result',
        status: 'partial',
        spawnId: 'spawn-a',
      },
    });
    ledger.record({
      name: 'resume_agent',
      args: { spawn_id: 'spawn-b' },
      content: 'other group completed',
      isError: false,
    });

    expect(goalLifecycleRefusalBeforeTool(
      ctx,
      'update_goal',
      { status: 'complete' },
      { effectiveToolNames },
    )).toContain('required work is still unresolved');

    ledger.record({
      name: 'resume_agent',
      args: { spawn_id: 'spawn-a' },
      content: 'original group completed',
      isError: false,
      structuredData: {
        kind: 'resume_agent_result',
        status: 'completed',
        spawnId: 'spawn-a',
      },
    });
    expect(goalLifecycleRefusalBeforeTool(
      ctx,
      'update_goal',
      { status: 'complete' },
      { effectiveToolNames },
    )).toBeNull();
  });

  it('keeps a partial collect_agents result unresolved until that spawn is recovered', () => {
    const { ctx, ledger, registry } = harness(activeGoal());
    registerTool(registry, 'collect_agents');
    registerTool(registry, 'resume_agent');
    const effectiveToolNames = new Set([
      'create_goal',
      'update_goal',
      'collect_agents',
      'resume_agent',
    ]);
    ledger.record({
      name: 'collect_agents',
      args: { job_id: 'job-a' },
      content: 'one agent stopped at its budget',
      isError: true,
      structuredData: {
        kind: 'collect_agents_result',
        status: 'partial',
        spawnId: 'spawn-a',
      },
    });
    expect(goalLifecycleRefusalBeforeTool(
      ctx,
      'update_goal',
      { status: 'complete' },
      { effectiveToolNames },
    )).toContain('required work is still unresolved');

    ledger.record({
      name: 'resume_agent',
      args: { spawn_id: 'spawn-a' },
      content: 'unfinished agent completed',
      isError: false,
    });
    expect(goalLifecycleRefusalBeforeTool(
      ctx,
      'update_goal',
      { status: 'complete' },
      { effectiveToolNames },
    )).toBeNull();
  });

  it('allows a successful resumed workflow to resolve its earlier terminal failure', () => {
    const { ctx, ledger, registry } = harness(activeGoal());
    registerTool(registry, 'workflow');
    const effectiveToolNames = new Set(['create_goal', 'update_goal', 'workflow']);
    ledger.record({
      name: 'workflow',
      args: { steps: [{ id: 'audit' }] },
      content: 'workflow partial',
      isError: true,
      structuredData: {
        kind: 'workflow_result',
        status: 'partial',
        workflowId: 'wf-recovery',
      },
    });
    ledger.record({
      name: 'workflow',
      args: { resume_workflow_id: 'wf-recovery', retry_failed: true },
      content: 'workflow completed',
      isError: false,
      structuredData: {
        kind: 'workflow_result',
        status: 'completed',
        workflowId: 'wf-recovery',
      },
    });

    expect(goalLifecycleRefusalBeforeTool(
      ctx,
      'update_goal',
      { status: 'complete' },
      { effectiveToolNames },
    )).toBeNull();
  });

  it('lets corrected arguments recover only the same pre-identity orchestration tool', () => {
    const { ctx, ledger, registry } = harness(activeGoal());
    registerTool(registry, 'task_list');
    registerTool(registry, 'execute_tasks');
    const effectiveToolNames = new Set([
      'create_goal',
      'update_goal',
      'task_list',
      'execute_tasks',
    ]);
    ledger.record({
      name: 'task_list',
      args: { action: 'invalid' },
      content: 'invalid task-list action',
      isError: true,
    });
    ledger.record({
      name: 'execute_tasks',
      args: { task_ids: ['other'] },
      content: 'other orchestration completed',
      isError: false,
    });
    expect(goalLifecycleRefusalBeforeTool(
      ctx,
      'update_goal',
      { status: 'complete' },
      { effectiveToolNames },
    )).toContain('required work is still unresolved');

    ledger.record({
      name: 'task_list',
      args: { action: 'get' },
      content: 'task list loaded',
      isError: false,
    });
    expect(goalLifecycleRefusalBeforeTool(
      ctx,
      'update_goal',
      { status: 'complete' },
      { effectiveToolNames },
    )).toBeNull();
  });

  it('allows a productive write capability to repair a failure from another editor', () => {
    const { ctx, ledger, registry } = harness(activeGoal());
    registerTool(registry, 'edit_file', { mutates: true, riskLevel: 'write' });
    registerTool(registry, 'apply_patch', {
      mutates: true,
      riskLevel: 'write',
      executionClass: 'write',
    });
    const effectiveToolNames = new Set([
      'create_goal',
      'update_goal',
      'edit_file',
      'apply_patch',
    ]);
    ledger.record({
      name: 'edit_file',
      args: { path: 'src/a.ts' },
      content: 'old string not found',
      isError: true,
      mutates: true,
    });
    ledger.record({
      name: 'apply_patch',
      args: { patch: 'repair the intended hunk' },
      content: 'updated',
      isError: false,
      mutates: true,
      executionClass: 'write',
    });

    expect(goalLifecycleRefusalBeforeTool(
      ctx,
      'update_goal',
      { status: 'complete' },
      { effectiveToolNames },
    )).toBeNull();
  });

  it('does not let an unrelated successful execution clear a failed execution', () => {
    const { ctx, ledger, registry } = harness(activeGoal());
    registerTool(registry, 'run_command', {
      mutates: false,
      riskLevel: 'execute',
      executionClass: 'execute',
    });
    const effectiveToolNames = new Set(['create_goal', 'update_goal', 'run_command']);
    ledger.record({
      name: 'run_command',
      args: { command: 'node broken-task.js' },
      content: 'command failed',
      isError: true,
      riskLevel: 'execute',
      executionClass: 'execute',
    });
    ledger.record({
      name: 'run_command',
      args: { command: 'node unrelated-task.js' },
      content: 'ok',
      isError: false,
      riskLevel: 'execute',
      executionClass: 'execute',
    });

    expect(goalLifecycleRefusalBeforeTool(
      ctx,
      'update_goal',
      { status: 'complete' },
      { effectiveToolNames },
    )).toContain('required work is still unresolved');
  });

  it('does not let a different successful package check clear a failed validation', () => {
    const { ctx, ledger, registry } = harness(activeGoal());
    registerTool(registry, 'run_command', {
      mutates: false,
      riskLevel: 'execute',
      executionClass: 'execute',
    });
    const effectiveToolNames = new Set(['create_goal', 'update_goal', 'run_command']);
    ledger.record({
      name: 'run_command',
      args: { command: 'pnpm run check:loc' },
      content: 'LOC cap exceeded',
      isError: true,
      executionClass: 'execute',
    });
    ledger.record({
      name: 'run_command',
      args: { command: 'pnpm run check:types' },
      content: 'types are clean',
      isError: false,
      executionClass: 'execute',
    });

    expect(goalLifecycleRefusalBeforeTool(
      ctx,
      'update_goal',
      { status: 'complete' },
      { effectiveToolNames },
    )).toContain('required work is still unresolved');
  });

  it('does not let a different target of the same validation script clear a failure', () => {
    const { ctx, ledger, registry } = harness(activeGoal());
    registerTool(registry, 'run_command', {
      mutates: false,
      riskLevel: 'execute',
      executionClass: 'execute',
    });
    const effectiveToolNames = new Set(['create_goal', 'update_goal', 'run_command']);
    ledger.record({
      name: 'run_command',
      args: { command: 'pnpm test -- failing-suite' },
      content: 'one test failed',
      isError: true,
      executionClass: 'execute',
    });
    ledger.record({
      name: 'run_command',
      args: { command: 'pnpm test -- easy-suite' },
      content: 'all tests passed',
      isError: false,
      executionClass: 'execute',
    });

    expect(goalLifecycleRefusalBeforeTool(
      ctx,
      'update_goal',
      { status: 'complete' },
      { effectiveToolNames },
    )).toContain('required work is still unresolved');

    ledger.record({
      name: 'run_command',
      args: { command: 'pnpm test -- failing-suite' },
      content: 'all tests passed',
      isError: false,
      executionClass: 'execute',
    });
    expect(goalLifecycleRefusalBeforeTool(
      ctx,
      'update_goal',
      { status: 'complete' },
      { effectiveToolNames },
    )).toBeNull();
  });

  it('accepts explicit user authority for earlier out-of-scope validation failures only', () => {
    const { ctx, ledger, registry } = harness(activeGoal());
    registerTool(registry, 'run_command', {
      mutates: false,
      riskLevel: 'execute',
      executionClass: 'execute',
    });
    registerTool(registry, 'ask_user', { mutates: false, riskLevel: 'read' });
    const effectiveToolNames = new Set([
      'create_goal',
      'update_goal',
      'run_command',
      'ask_user',
    ]);
    ledger.record({
      name: 'run_command',
      args: { command: 'pnpm run check:loc' },
      content: 'pre-existing LOC baseline drift',
      isError: true,
      executionClass: 'execute',
    });
    ledger.record({
      name: 'run_command',
      args: { command: 'pnpm run audit:env:check' },
      content: 'pre-existing env baseline drift',
      isError: true,
      executionClass: 'execute',
    });

    expect(goalLifecycleRefusalBeforeTool(
      ctx,
      'update_goal',
      { status: 'complete' },
      { effectiveToolNames },
    )).toContain('required work is still unresolved');

    ledger.record({
      name: 'ask_user',
      args: {
        question: 'May the two failed baseline validations be treated as out of scope?',
        options: [
          {
            label: 'Complete — drift is out of scope',
            value: 'complete',
            goal_lifecycle_resolution: 'accept_out_of_scope_validation',
          },
          { label: 'Repair them', value: 'repair' },
        ],
      },
      content: 'User answered: complete',
      isError: false,
    });
    expect(goalLifecycleRefusalBeforeTool(
      ctx,
      'update_goal',
      { status: 'complete' },
      { effectiveToolNames },
    )).toBeNull();
  });

  it('does not let a validation waiver hide an ordinary failed mutation', () => {
    const { ctx, ledger, registry } = harness(activeGoal());
    registerTool(registry, 'edit_file', { mutates: true, riskLevel: 'write' });
    registerTool(registry, 'ask_user', { mutates: false, riskLevel: 'read' });
    const effectiveToolNames = new Set([
      'create_goal',
      'update_goal',
      'edit_file',
      'ask_user',
    ]);
    ledger.record({
      name: 'edit_file',
      args: { path: 'src/index.ts' },
      content: 'write failed',
      isError: true,
      mutates: true,
    });
    ledger.record({
      name: 'ask_user',
      args: {
        question: 'May failed validation be treated as out of scope?',
        options: [
          {
            label: 'Accept validation drift',
            value: 'accept',
            goal_lifecycle_resolution: 'accept_out_of_scope_validation',
          },
          { label: 'Keep working', value: 'continue' },
        ],
      },
      content: 'User answered: accept',
      isError: false,
    });

    expect(goalLifecycleRefusalBeforeTool(
      ctx,
      'update_goal',
      { status: 'complete' },
      { effectiveToolNames },
    )).toContain('required work is still unresolved');
  });

  it('uses the role-available escalation tool in an in-progress nudge', () => {
    const { ctx, ledger, registry } = harness(activeGoal());
    registerTool(registry, 'edit_file', { mutates: true, riskLevel: 'write' });
    registerTool(registry, 'ask_master', { mutates: false, riskLevel: 'read' });
    ledger.record({
      name: 'edit_file',
      args: { path: 'src/index.ts' },
      content: 'updated',
      isError: false,
      mutates: true,
    });

    const decision = evaluateGoalLifecycleAtFinish(ctx, {
      effectiveToolNames: new Set([
        'create_goal',
        'update_goal',
        'edit_file',
        'ask_master',
      ]),
    });
    expect(decision).toMatchObject({ kind: 'nudge', phase: 'in_progress' });
    expect(decision?.kind === 'nudge' ? decision.text : '').toContain('`ask_master`');
    expect(decision?.kind === 'nudge' ? decision.text : '').not.toContain('`ask_user`');
  });

  it('uses bounded independent retry budgets for missing and in-progress phases', () => {
    const { ctx, ledger, registry, setGoal } = harness();
    registerTool(registry, 'read_file', { mutates: false, riskLevel: 'read' });
    ledger.record({
      name: 'read_file',
      args: { path: 'src/index.ts' },
      content: 'source',
      isError: false,
    });
    ledger.record({
      name: 'read_file',
      args: { path: 'src/runner.ts' },
      content: 'more source',
      isError: false,
    });
    ledger.record({
      name: 'read_file',
      args: { path: 'src/store.ts' },
      content: 'third source',
      isError: false,
    });

    expect(evaluateGoalLifecycleAtFinish(ctx, { maxNudgesPerPhase: 1 })).toMatchObject({
      kind: 'nudge',
      phase: 'missing',
    });
    expect(evaluateGoalLifecycleAtFinish(ctx, { maxNudgesPerPhase: 1 })).toMatchObject({
      kind: 'violation',
      phase: 'missing',
    });

    setGoal(activeGoal());
    expect(evaluateGoalLifecycleAtFinish(ctx, { maxNudgesPerPhase: 1 })).toMatchObject({
      kind: 'nudge',
      phase: 'in_progress',
    });
    expect(evaluateGoalLifecycleAtFinish(ctx, { maxNudgesPerPhase: 1 })).toMatchObject({
      kind: 'violation',
      phase: 'in_progress',
    });
  });

  it('requires a fresh goal for substantive work when completion was inherited', () => {
    const { ctx, ledger, registry } = harness(activeGoal('complete'));
    registerTool(registry, 'edit_file', { mutates: true, riskLevel: 'write' });
    ledger.record({
      name: 'edit_file',
      args: { path: 'src/index.ts' },
      content: 'updated',
      isError: false,
      mutates: true,
    });

    expect(evaluateGoalLifecycleAtFinish(ctx)).toMatchObject({
      kind: 'nudge',
      phase: 'missing',
    });
  });

  it('allows a goal that was completed after this run substantive work', () => {
    const { ctx, ledger, registry } = harness(activeGoal('complete'));
    registerTool(registry, 'edit_file', { mutates: true, riskLevel: 'write' });
    ledger.record({
      name: 'edit_file',
      args: { path: 'src/index.ts' },
      content: 'updated',
      isError: false,
      mutates: true,
    });
    ledger.record({
      name: 'update_goal',
      args: { status: 'complete' },
      content: 'Goal marked complete.',
      isError: false,
    });

    expect(evaluateGoalLifecycleAtFinish(ctx)).toBeNull();
  });

  it('requires a fresh goal for substantive work performed after completion', () => {
    const { ctx, ledger, registry } = harness(activeGoal('complete'));
    registerTool(registry, 'edit_file', { mutates: true, riskLevel: 'write' });
    ledger.record({
      name: 'update_goal',
      args: { status: 'complete' },
      content: 'Goal marked complete.',
      isError: false,
    });
    ledger.record({
      name: 'edit_file',
      args: { path: 'src/next.ts' },
      content: 'updated',
      isError: false,
      mutates: true,
    });

    expect(evaluateGoalLifecycleAtFinish(ctx)).toMatchObject({
      kind: 'nudge',
      phase: 'missing',
    });
  });
});
