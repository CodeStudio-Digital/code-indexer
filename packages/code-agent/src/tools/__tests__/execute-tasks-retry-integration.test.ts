/**
 * PR-C: end-to-end retry flow through execute_tasks.
 * Asserts that transient subagent errors trigger retry with per-attempt
 * persistence, fatal errors don't retry, and explicit run policy is respected.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '@mcp/code-agent/core/tool.js';
import type { CoderTask, TasksState } from '@mcp/session-storage/session-state-types.js';
import type { FsSessionStore } from '@mcp/session-storage/fs-store/index.js';
import { newSessionId } from '@mcp/session-storage';

const SESSION_ID = newSessionId();

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
    id: 'tsk_base', title: 'Base', description: 'desc',
    files: [], references: [], depends_on: [],
    suggested_mode: 'subagent', estimated_complexity: 'medium',
    kind: 'implement', status: 'pending',
    ...overrides,
  };
}

function makeMockStore() {
  return {
    createTaskRun: vi.fn(),
    updateTaskRun: vi.fn(),
    upsertTaskRunItem: vi.fn(),
    getTaskRun: vi.fn(),
    listTaskRunsBySession: vi.fn(),
    listTaskRunItems: vi.fn(),
    getTaskRunWithItems: vi.fn(),
    recoverRunningTaskRuns: vi.fn(),
    findLastCompletedTaskItem: vi.fn(() => null),
  };
}

function setup(tasks: CoderTask[], maxRetries = 2) {
  const store = makeMockStore();
  const runner = {
    emit: vi.fn(),
    sessionId: SESSION_ID,
    agentLoopV2: false,
  };
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
    sessionStore: store as unknown as FsSessionStore,
    executeTasksRetryConfig: { maxRetries, initialMs: 0, maxMs: 0, jitter: 0 },
  });
  return { tool, ctx, runner, store };
}

beforeEach(() => {
  vi.mocked(runSubagent).mockReset();
});

describe('execute_tasks retry integration', () => {
  it('persists uncertainty and never retries based on a salvage summary or retryable transport failure', async () => {
    vi.mocked(runSubagent).mockResolvedValue({
      reason: 'completed', finalText: 'partial work retained', failureDetail: 'ECONNRESET',
      effectOutcome: 'unknown', usage: { input_tokens: 1, output_tokens: 0 }, sandboxViolations: [],
    });
    const { tool, ctx, store } = setup([task({ id: 'tsk_uncertain' })]);
    const outcome = await tool.handler({}, ctx);
    expect(outcome).toMatchObject({ isError: true, effectOutcome: 'unknown' });
    expect(runSubagent).toHaveBeenCalledTimes(1);
    expect(ctx.updateTaskStatus).toHaveBeenCalledWith('tsk_uncertain', expect.objectContaining({
      status: 'failed', result: expect.objectContaining({ effectOutcome: 'unknown', errors: 'outcome_unknown: ECONNRESET' }),
    }));
    expect(store.upsertTaskRunItem.mock.calls.filter(c => c[0].status === 'failed')).toHaveLength(1);
  });

  it('rejects rerunning a task with a persisted uncertain outcome', async () => {
    const { tool, ctx } = setup([task({ id: 'tsk_uncertain', status: 'pending',
      result: { summary: 'unconfirmed write', files_modified: [], effectOutcome: 'unknown' } })]);
    const result = await tool.handler({}, ctx);
    expect(result.isError).toBe(true);
    expect(runSubagent).not.toHaveBeenCalled();
  });

  it('stops retrying when the parent is cancelled during a child attempt', async () => {
    const controller = new AbortController();
    vi.mocked(runSubagent).mockImplementation(async () => {
      controller.abort(new Error('parent cancelled'));
      return { reason: 'error', finalText: 'ECONNRESET', usage: { input_tokens: 0, output_tokens: 0 }, sandboxViolations: [] };
    });
    const { tool, ctx } = setup([task()]);
    ctx.signal = controller.signal;
    await tool.handler({}, ctx);
    expect(runSubagent).toHaveBeenCalledTimes(1);
  });

  it('transient subagent failure → retry → second attempt succeeds', async () => {
    let i = 0;
    vi.mocked(runSubagent).mockImplementation(async () => {
      i++;
      if (i === 1) {
        return {
          reason: 'error', finalText: 'ETIMEDOUT calling provider',
          usage: { input_tokens: 1, output_tokens: 0 }, sandboxViolations: [],
        };
      }
      return {
        reason: 'completed', finalText: 'OK on retry',
        usage: { input_tokens: 5, output_tokens: 3 }, sandboxViolations: [],
      };
    });

    const { tool, ctx, store, runner } = setup([task({ id: 'tsk_one' })]);
    const result = await tool.handler({}, ctx);

    expect(result.isError).toBeFalsy();
    expect(runSubagent).toHaveBeenCalledTimes(2);
    expect(runner.emit).toHaveBeenCalledWith(
      'task_finished',
      expect.objectContaining({ task_id: 'tsk_one', status: 'done' }),
    );
    const finishedCalls = store.upsertTaskRunItem.mock.calls.filter(
      (c) => c[0].task_id === 'tsk_one' && (c[0].status === 'failed' || c[0].status === 'done'),
    );
    expect(finishedCalls.length).toBe(2);
    expect(finishedCalls.map((c) => c[0].attempt).sort()).toEqual([0, 1]);
  });

  it('fatal subagent failure → no retry, single attempt', async () => {
    vi.mocked(runSubagent).mockResolvedValue({
      reason: 'error', finalText: 'HTTP 401 Unauthorized',
      usage: { input_tokens: 0, output_tokens: 0 }, sandboxViolations: [],
    });
    const { tool, ctx, store } = setup([task({ id: 'tsk_one' })]);
    await tool.handler({}, ctx);

    expect(runSubagent).toHaveBeenCalledTimes(1);
    const finishedCalls = store.upsertTaskRunItem.mock.calls.filter(
      (c) => c[0].task_id === 'tsk_one' && c[0].status === 'failed',
    );
    expect(finishedCalls.length).toBe(1);
    expect(finishedCalls[0][0].attempt).toBe(0);
  });

  it('persistent transient failure exhausts retries (3 attempts total)', async () => {
    vi.mocked(runSubagent).mockResolvedValue({
      reason: 'error', finalText: 'ECONNRESET',
      usage: { input_tokens: 1, output_tokens: 0 }, sandboxViolations: [],
    });
    const { tool, ctx, store } = setup([task({ id: 'tsk_one' })]);
    await tool.handler({}, ctx);

    expect(runSubagent).toHaveBeenCalledTimes(3);
    const failedCalls = store.upsertTaskRunItem.mock.calls.filter(
      (c) => c[0].task_id === 'tsk_one' && c[0].status === 'failed',
    );
    expect(failedCalls.length).toBe(3);
    expect(failedCalls.map((c) => c[0].attempt).sort()).toEqual([0, 1, 2]);
  });

  it('respects an explicit zero-retry run policy', async () => {
    vi.mocked(runSubagent).mockResolvedValue({
      reason: 'error', finalText: 'ETIMEDOUT',
      usage: { input_tokens: 0, output_tokens: 0 }, sandboxViolations: [],
    });
    const { tool, ctx } = setup([task({ id: 'tsk_one' })], 0);
    await tool.handler({}, ctx);
    expect(runSubagent).toHaveBeenCalledTimes(1);
  });

  it('does not retry an explicit operational budget cutoff', async () => {
    vi.mocked(runSubagent).mockResolvedValue({
      reason: 'time_budget', finalText: 'partial work retained',
      usage: { input_tokens: 20, output_tokens: 5 }, sandboxViolations: [],
    });
    const { tool, ctx, runner } = setup([task({ id: 'tsk_one' })]);
    await tool.handler({}, ctx);

    expect(runSubagent).toHaveBeenCalledTimes(1);
    expect(runner.emit).toHaveBeenCalledWith(
      'task_finished',
      expect.objectContaining({ task_id: 'tsk_one', status: 'interrupted' }),
    );
  });
});
