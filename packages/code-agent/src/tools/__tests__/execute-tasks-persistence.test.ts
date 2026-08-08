/**
 * PR-B: write-through persistence from `execute_tasks` to the
 * independent task-run entities in the owner session bundle.
 *
 * These tests use a mock `FsSessionStore` so we can assert the exact
 * sequence and shape of file-backed writes.
 *
 * Invariants under test:
 *   - One `createTaskRun` per execute_tasks call.
 *   - One `upsertTaskRunItem(status='running')` per task start.
 *   - One `upsertTaskRunItem(status='done'|'failed'|'skipped')` per finish.
 *   - One `updateTaskRun(status='completed'|'failed'|'aborted')` at the end.
 *   - Inline-all refusal emits `updateTaskRun(status='aborted', reject_reason)`.
 *   - When `sessionStore` is undefined, the bridge becomes a no-op and
 *     the orchestrator never throws.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '@mcp/code-agent/core/tool.js';
import type { CoderTask, TasksState } from '@mcp/code-agent/sessions/types.js';
import type { FsSessionStore } from '@mcp/code-agent/sessions/fs-store/index.js';
import { newSessionId, type SessionId } from '@mcp/session-storage';

const SESSION_ID = newSessionId();
const SECOND_SESSION_ID = newSessionId();

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
    id: 'tsk_base',
    title: 'Base',
    description: 'desc',
    files: ['src/base.ts'],
    references: [],
    depends_on: [],
    suggested_mode: 'subagent',
    estimated_complexity: 'medium',
    kind: 'implement',
    status: 'pending',
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

type MockStore = ReturnType<typeof makeMockStore>;

function setup(
  tasks: CoderTask[],
  opts: {
    execution_mode?: TasksState['execution_mode'];
    store?: MockStore | null;
    sessionId?: SessionId | null;
  } = {},
) {
  const store = opts.store ?? makeMockStore();
  // Use ternary not `??` so explicit `null` reaches the runner (the test
  // for "no session" wants runner.sessionId === null.
  const sessionId =
    opts.sessionId === undefined ? SESSION_ID : opts.sessionId;
  const runner = {
    emit: vi.fn(),
    sessionId,
    agentLoopV2: false,
    beginTaskScope: vi.fn(),
    currentTaskScopeId: vi.fn(() => null),
  };
  const state: TasksState = {
    summary: 'Run tasks',
    tasks,
    execution_mode: opts.execution_mode ?? 'all-subagent',
    approved: true,
    current_task_id: null,
  };
  const ctx = {
    cwd: 'D:/MCP',
    projectName: 'test',
    runner,
    getTasksState: () => state,
    updateTaskStatus: vi.fn(),
    reportProgress: vi.fn(),
  } as unknown as ToolContext;
  const tool = buildExecuteTasksTool({
    provider: {} as never,
    parentTools: [],
    sessionStore: store as unknown as FsSessionStore | undefined,
    executeTasksRetryConfig: { maxRetries: 0, initialMs: 0, maxMs: 0, jitter: 0 },
  });
  return { tool, ctx, runner, store };
}

beforeEach(() => {
  vi.mocked(runSubagent).mockReset();
});

describe('execute_tasks persistence bridge (PR-B)', () => {
  it('createTaskRun fires once with session_id + mode + started_at', async () => {
    vi.mocked(runSubagent).mockResolvedValue({
      reason: 'completed',
      finalText: 'ok',
      usage: { input_tokens: 1, output_tokens: 1 },
      sandboxViolations: [],
    });
    const { tool, ctx, store } = setup(
      [task({ id: 'tsk_one' })],
      { sessionId: SECOND_SESSION_ID },
    );
    await tool.handler({}, ctx);

    expect(store.createTaskRun).toHaveBeenCalledTimes(1);
    expect(store.createTaskRun).toHaveBeenCalledWith(
      expect.objectContaining({
        session_id: SECOND_SESSION_ID,
        mode: 'auto',
        run_id: expect.stringMatching(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
        ),
        started_at: expect.any(String),
      }),
    );
  });

  it('upsertTaskRunItem fires twice per task: once with running, once with done', async () => {
    vi.mocked(runSubagent).mockResolvedValue({
      reason: 'completed',
      finalText: 'first',
      usage: { input_tokens: 2, output_tokens: 1 },
      sandboxViolations: [],
    });
    const { tool, ctx, store } = setup([task({ id: 'tsk_one' })]);
    await tool.handler({}, ctx);

    expect(store.upsertTaskRunItem).toHaveBeenCalledTimes(2);
    const calls = store.upsertTaskRunItem.mock.calls;
    expect(calls[0][0]).toMatchObject({ task_id: 'tsk_one', status: 'running' });
    expect(calls[1][0]).toMatchObject({
      task_id: 'tsk_one',
      status: 'done',
      tool_call_count: expect.any(Number),
      summary: 'first',
    });
  });

  it('records a failed task with error + status=failed', async () => {
    vi.mocked(runSubagent).mockResolvedValue({
      reason: 'error',
      finalText: 'boom',
      usage: { input_tokens: 0, output_tokens: 0 },
      sandboxViolations: [],
    });
    const { tool, ctx, store } = setup([task({ id: 'tsk_fail' })]);
    await tool.handler({}, ctx);

    const finishCall = store.upsertTaskRunItem.mock.calls.find(
      (c) => c[0].status === 'failed',
    );
    expect(finishCall).toBeDefined();
    expect(finishCall?.[0]).toMatchObject({
      task_id: 'tsk_fail',
      status: 'failed',
      error: 'boom',
    });
  });

  it('records skipped tasks with skip_reason="dependency_failed"', async () => {
    let call = 0;
    vi.mocked(runSubagent).mockImplementation(async () => {
      call++;
      if (call === 1) {
        return {
          reason: 'error',
          finalText: 'A failed',
          usage: { input_tokens: 0, output_tokens: 0 },
          sandboxViolations: [],
        };
      }
      return {
        reason: 'completed',
        finalText: 'unused',
        usage: { input_tokens: 0, output_tokens: 0 },
        sandboxViolations: [],
      };
    });
    const { tool, ctx, store } = setup([
      task({ id: 'tsk_a' }),
      task({ id: 'tsk_b', depends_on: ['tsk_a'] }),
    ]);
    await tool.handler({}, ctx);

    const skipCall = store.upsertTaskRunItem.mock.calls.find(
      (c) => c[0].task_id === 'tsk_b' && c[0].status === 'skipped',
    );
    expect(skipCall).toBeDefined();
    expect(skipCall?.[0]).toMatchObject({
      status: 'skipped',
      skip_reason: expect.stringContaining('dependency_'),
    });
  });

  it('updateTaskRun(status=completed) at the end of a successful run', async () => {
    vi.mocked(runSubagent).mockResolvedValue({
      reason: 'completed',
      finalText: 'ok',
      usage: { input_tokens: 10, output_tokens: 5 },
      sandboxViolations: [],
    });
    const { tool, ctx, store } = setup([task({ id: 'tsk_one' })]);
    await tool.handler({}, ctx);

    expect(store.updateTaskRun).toHaveBeenCalledTimes(1);
    expect(store.updateTaskRun).toHaveBeenCalledWith(
      SESSION_ID,
      expect.any(String),
      expect.objectContaining({
        status: 'completed',
        finished_at: expect.any(String),
        total_input_tokens: 10,
        total_output_tokens: 5,
      }),
    );
  });

  it('does NOT emit updateTaskRun(finished) when inline scope opens (run still running)', async () => {
    // PR-G: inline-all path now OPENS a scope mid-run instead of bailing
    // with `status='aborted'`. Persistence layer reflects this — the run
    // row stays in `status='running'` until task_complete + next
    // execute_tasks call drive it forward. We only assert what should
    // NOT happen here; the full inline lifecycle is covered in the
    // inline-scope integration tests.
    const { tool, ctx, store } = setup(
      [task({ id: 'tsk_one', suggested_mode: 'inline' })],
      { execution_mode: 'inline' },
    );
    await tool.handler({}, ctx);
    // No `aborted` updateTaskRun call.
    const abortedCall = store.updateTaskRun.mock.calls.find(
      (c) => (c[2] as { status?: string }).status === 'aborted',
    );
    expect(abortedCall).toBeUndefined();
  });

  it('updateTaskRun(status=failed) when any task fails', async () => {
    vi.mocked(runSubagent).mockResolvedValue({
      reason: 'error',
      finalText: 'crashed',
      usage: { input_tokens: 1, output_tokens: 1 },
      sandboxViolations: [],
    });
    const { tool, ctx, store } = setup([task({ id: 'tsk_one' })]);
    await tool.handler({}, ctx);
    expect(store.updateTaskRun).toHaveBeenCalledWith(
      SESSION_ID,
      expect.any(String),
      expect.objectContaining({ status: 'failed' }),
    );
  });

  it('persistence is a no-op when sessionStore is undefined', async () => {
    vi.mocked(runSubagent).mockResolvedValue({
      reason: 'completed',
      finalText: 'ok',
      usage: { input_tokens: 1, output_tokens: 1 },
      sandboxViolations: [],
    });
    const runner = {
      emit: vi.fn(),
      sessionId: SESSION_ID,
      agentLoopV2: false,
    };
    const state: TasksState = {
      summary: '', tasks: [task({ id: 'tsk_one' })],
      execution_mode: 'all-subagent', approved: true, current_task_id: null,
    };
    const ctx = {
      cwd: 'D:/MCP', projectName: 'test', runner,
      getTasksState: () => state,
      updateTaskStatus: vi.fn(),
      reportProgress: vi.fn(),
    } as unknown as ToolContext;
    const { buildExecuteTasksTool } = await import('../execute-tasks.js');
    const tool = buildExecuteTasksTool({
      provider: {} as never,
      parentTools: [],
      sessionStore: undefined,
      executeTasksRetryConfig: { maxRetries: 0, initialMs: 0, maxMs: 0, jitter: 0 },
    });
    const result = await tool.handler({}, ctx);
    expect(result.isError).toBeFalsy();
  });

  it('persistence is a no-op when sessionId is missing', async () => {
    vi.mocked(runSubagent).mockResolvedValue({
      reason: 'completed',
      finalText: 'ok',
      usage: { input_tokens: 1, output_tokens: 1 },
      sandboxViolations: [],
    });
    const store = makeMockStore();
    const { tool, ctx } = setup([task({ id: 'tsk_one' })], { store, sessionId: null });
    await tool.handler({}, ctx);
    // Without sessionId, the bridge returns NOOP_PERSIST → no bundle writes.
    expect(store.createTaskRun).not.toHaveBeenCalled();
    expect(store.updateTaskRun).not.toHaveBeenCalled();
    expect(store.upsertTaskRunItem).not.toHaveBeenCalled();
  });

  it('fails closed when the task-run journal cannot be written', async () => {
    vi.mocked(runSubagent).mockResolvedValue({
      reason: 'completed',
      finalText: 'ok',
      usage: { input_tokens: 1, output_tokens: 1 },
      sandboxViolations: [],
    });
    const store = makeMockStore();
    store.createTaskRun.mockImplementation(() => { throw new Error('disk full'); });
    store.upsertTaskRunItem.mockImplementation(() => { throw new Error('disk full'); });
    store.updateTaskRun.mockImplementation(() => { throw new Error('disk full'); });
    const { tool, ctx } = setup([task({ id: 'tsk_one' })], { store });
    await expect(tool.handler({}, ctx)).rejects.toThrow('disk full');
  });
});
