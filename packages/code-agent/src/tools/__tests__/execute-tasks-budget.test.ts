/**
 * PR-E execute_tasks integration with `BudgetTracker` + interactive
 * ask via runner.waitForUserInput. Unit tests for the tracker itself
 * live in `budget-tracker.test.ts`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { newSessionId } from '@mcp/session-storage';
import type { ToolContext } from '@mcp/code-agent/core/tool.js';
import type { CoderTask, TasksState } from '@mcp/session-storage/session-state-types.js';

vi.mock('../implement-subagent.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../implement-subagent.js')>();
  return {
    ...actual,
    runSubagent: vi.fn(),
    runParallelAgents: vi.fn(),
  };
});

const { buildExecuteTasksTool } = await import('../execute-tasks.js');
const { runSubagent } = await import('../implement-subagent.js');

function task(overrides: Partial<CoderTask> = {}): CoderTask {
  return {
    id: 'tsk_a', title: 'A', description: 'desc',
    files: [], references: [], depends_on: [],
    suggested_mode: 'subagent', estimated_complexity: 'medium',
    kind: 'implement', status: 'pending',
    ...overrides,
  };
}

function makeStubRunner(answer: string | null) {
  const listeners: Record<string, Array<(...args: unknown[]) => void>> = {};
  const pending = new Map<string, (v: string) => void>();
  return {
    emit: vi.fn((event: string, payload: unknown) => {
      const list = listeners[event] ?? [];
      for (const l of list) l(payload);
      if (event === 'budget_request' && answer !== null) {
        const askId = (payload as { ask_id: string }).ask_id;
        // A synchronous UI response must find an already registered waiter.
        const r = pending.get(askId);
        if (r) { pending.delete(askId); r(answer); }
      }
      return true;
    }),
    on: (event: string, fn: (...args: unknown[]) => void) => {
      (listeners[event] ??= []).push(fn);
    },
    sessionId: newSessionId(),
    agentLoopV2: false,
    waitForUserInput: (askId?: string) => new Promise<string>((r) => {
      const key = askId ?? '__default__';
      pending.set(key, r);
    }),
    provideUserInput: (v: string, askId?: string) => {
      const key = askId ?? '__default__';
      const r = pending.get(key);
      if (!r) return false;
      pending.delete(key); r(v); return true;
    },
    isWaitingForInput: (askId?: string) =>
      askId !== undefined ? pending.has(askId) : pending.size > 0,
  };
}

function setupCtx(
  tasks: CoderTask[],
  runner: ReturnType<typeof makeStubRunner>,
  options: { tokenCap?: number | null; responseTimeoutMs?: number } = {},
) {
  const state: TasksState = {
    summary: '', tasks, execution_mode: 'all-subagent',
    approved: true, current_task_id: null,
  };
  const ctx = {
    cwd: 'D:/MCP', projectName: 'test', runner,
    getTasksState: () => state,
    updateTaskStatus: vi.fn(),
    reportProgress: vi.fn(),
  } as unknown as ToolContext;
  const tool = buildExecuteTasksTool({
    provider: {} as never,
    parentTools: [],
    sessionStore: undefined,
    executeTasksTokenCap: options.tokenCap,
    executeTasksBudgetResponseTimeoutMs: options.responseTimeoutMs,
    executeTasksRetryConfig: { maxRetries: 0, initialMs: 0, maxMs: 0, jitter: 0 },
  });
  return { tool, ctx };
}

beforeEach(() => {
  vi.mocked(runSubagent).mockReset();
});

describe('execute_tasks budget integration', () => {
  it('no cap → all tasks dispatch normally (no budget_request)', async () => {
    vi.mocked(runSubagent).mockResolvedValue({
      reason: 'completed', finalText: 'ok',
      usage: { input_tokens: 100, output_tokens: 50 }, sandboxViolations: [],
    });
    const runner = makeStubRunner('cancel_pending');
    const { tool, ctx } = setupCtx(
      [task({ id: 'tsk_1' }), task({ id: 'tsk_2' })],
      runner,
    );
    await tool.handler({}, ctx);

    expect(runSubagent).toHaveBeenCalledTimes(2);
    const budgetEmits = runner.emit.mock.calls.filter((c) => c[0] === 'budget_request');
    expect(budgetEmits.length).toBe(0);
  });

  it('maps investigate complexity to a soft research policy', async () => {
    vi.mocked(runSubagent).mockResolvedValue({
      reason: 'completed', finalText: 'ok',
      usage: { input_tokens: 100, output_tokens: 50 }, sandboxViolations: [],
    });
    const runner = makeStubRunner('cancel_pending');
    const { tool, ctx } = setupCtx(
      [task({ kind: 'investigate', estimated_complexity: 'medium' })],
      runner,
    );

    await tool.handler({}, ctx);

    expect(runSubagent).toHaveBeenCalledTimes(1);
    expect(vi.mocked(runSubagent).mock.calls[0]?.[1].researchPolicy).toMatchObject({
      depth: 'standard',
      softToolTarget: 40,
      softTimeTargetMs: 7 * 60_000,
    });
  });

  it('cap exceeded → budget_request emitted, "stop_after_current" skips remaining', async () => {
    vi.mocked(runSubagent).mockResolvedValue({
      reason: 'completed', finalText: 'ok',
      usage: { input_tokens: 50, output_tokens: 50 }, sandboxViolations: [],
    });
    const runner = makeStubRunner('stop_after_current');
    const { tool, ctx } = setupCtx(
      [task({ id: 'tsk_1' }), task({ id: 'tsk_2' })],
      runner,
      { tokenCap: 100 },
    );
    await tool.handler({}, ctx);

    // Default estimatePerTask = 5000 > cap=100, gate fires on FIRST task.
    // User picks stop_after_current → both tasks skip without running.
    expect(runSubagent).not.toHaveBeenCalled();
    const budgetEmits = runner.emit.mock.calls.filter((c) => c[0] === 'budget_request');
    expect(budgetEmits.length).toBe(1);
    const finishedEmits = runner.emit.mock.calls.filter(
      (c) => c[0] === 'task_finished' && (c[1] as { status: string }).status === 'skipped',
    );
    expect(finishedEmits.length).toBe(2);
  });

  it('"cancel_pending" answer aborts every queued task as skipped', async () => {
    const runner = makeStubRunner('cancel_pending');
    const { tool, ctx } = setupCtx(
      [task({ id: 'tsk_1' }), task({ id: 'tsk_2' }), task({ id: 'tsk_3' })],
      runner,
      { tokenCap: 50 },
    );
    await tool.handler({}, ctx);

    expect(runSubagent).not.toHaveBeenCalled();
    const skipped = runner.emit.mock.calls.filter(
      (c) => c[0] === 'task_finished' && (c[1] as { status: string }).status === 'skipped',
    );
    expect(skipped.length).toBe(3);
  });

  it('"continue+50%" raises the cap and lets the run finish', async () => {
    vi.mocked(runSubagent).mockResolvedValue({
      reason: 'completed', finalText: 'ok',
      usage: { input_tokens: 100, output_tokens: 100 }, sandboxViolations: [],
    });
    const runner = makeStubRunner('continue+50%');
    const { tool, ctx } = setupCtx(
      [task({ id: 'tsk_1' })],
      runner,
      { tokenCap: 4000 },
    );
    await tool.handler({}, ctx);

    // estimatePerTask=5000 > cap=4000 → gate fires, user extends to 6000,
    // task proceeds.
    expect(runSubagent).toHaveBeenCalledTimes(1);
  });

  it('fails safe instead of waiting forever when no budget UI answers', async () => {
    const runner = makeStubRunner(null);
    const { tool, ctx } = setupCtx(
      [task({ id: 'tsk_1' }), task({ id: 'tsk_2' })],
      runner,
      { tokenCap: 50, responseTimeoutMs: 5 },
    );

    await tool.handler({}, ctx);

    expect(runSubagent).not.toHaveBeenCalled();
    expect(runner.isWaitingForInput()).toBe(false);
    const skipped = runner.emit.mock.calls.filter(
      (c) => c[0] === 'task_finished' && (c[1] as { status: string }).status === 'skipped',
    );
    expect(skipped).toHaveLength(2);
  });
});
