import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '@mcp/code-agent/core/tool.js';
import type { CoderTask, TasksState } from '@mcp/code-agent/sessions/types.js';

vi.mock('../implement-subagent.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../implement-subagent.js')>();
  return {
    ...actual,
    runSubagent: vi.fn(),
    runParallelAgents: vi.fn(),
  };
});

const { buildExecuteTasksTool } = await import('../execute-tasks.js');
const { runSubagent, runParallelAgents } = await import('../implement-subagent.js');

function task(overrides: Partial<CoderTask> = {}): CoderTask {
  return {
    id: 'tsk_base',
    title: 'Base task',
    description: 'Do the base task',
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

function setup(tasks: CoderTask[], overrides: Partial<TasksState> = {}) {
  const runner = {
    emit: vi.fn(),
    sessionId: 123,
    agentLoopV2: false,
    beginTaskScope: vi.fn(),
    currentTaskScopeId: vi.fn(() => null),
  };
  const state: TasksState = {
    summary: 'Run tasks',
    tasks,
    execution_mode: 'all-subagent',
    approved: true,
    current_task_id: null,
    ...overrides,
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
    sessionStore: undefined,
  });
  return { tool, ctx, runner };
}

beforeEach(() => {
  vi.mocked(runSubagent).mockReset();
  vi.mocked(runParallelAgents).mockReset();
  // PR-C: pin retries off so legacy tests (which assume each run is a
  // single attempt) behave like they did before retry was introduced.
  // The retry behavior itself is covered in execute-tasks-retry.test.ts.
  vi.stubEnv('CODER_TASK_MAX_RETRIES', '0');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('execute_tasks timeline events', () => {
  it('emits task run events for sequential subagent tasks', async () => {
    vi.mocked(runSubagent).mockImplementation(async (_parent, spec) => {
      spec.onProgress?.({
        event: 'heartbeat',
        toolCallCount: 0,
        toolName: 'provider.chat',
        note: 'awaiting model',
      });
      spec.onProgress?.({
        event: 'tool_call',
        toolCallCount: 1,
        toolName: 'read_file',
        note: 'read_file completed',
      });
      return {
        reason: 'completed',
        finalText: 'Sequential summary',
        usage: { input_tokens: 10, output_tokens: 2 },
        sandboxViolations: [],
      };
    });

    const { tool, ctx, runner } = setup([task({ id: 'tsk_one', title: 'One' })]);
    const result = await tool.handler({}, ctx);
    const spec = vi.mocked(runSubagent).mock.calls[0][1];

    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('tools=1');
    expect(spec.pathScope).toEqual(['src/base.ts']);
    expect(spec.pathScopeMode).toBe('enforce-writes');
    expect(runner.emit).toHaveBeenCalledWith(
      'task_run_started',
      expect.objectContaining({ total_tasks: 1 }),
    );
    expect(runner.emit).toHaveBeenCalledWith(
      'task_run_task_started',
      expect.objectContaining({ task_id: 'tsk_one', wave: 1, kind: 'implement' }),
    );
    expect(runner.emit).toHaveBeenCalledWith(
      'task_run_task_progress',
      expect.objectContaining({ task_id: 'tsk_one', tool_call_count: 0, note: 'awaiting model' }),
    );
    expect(runner.emit).toHaveBeenCalledWith(
      'task_run_task_progress',
      expect.objectContaining({ task_id: 'tsk_one', tool_call_count: 1 }),
    );
    expect(runner.emit).toHaveBeenCalledWith(
      'task_run_task_finished',
      expect.objectContaining({ task_id: 'tsk_one', status: 'done', tool_call_count: 1 }),
    );
    expect(runner.emit).toHaveBeenCalledWith(
      'task_run_finished',
      expect.objectContaining({ status: 'completed' }),
    );
    expect(ctx.reportProgress).toHaveBeenCalledWith(expect.stringContaining('Wave 1/1'));
  });

  it('translates parallel agent progress into task run progress events', async () => {
    vi.mocked(runParallelAgents).mockImplementation(async (_parent, agents, _system, _allowlist, onProgress) => {
      onProgress({ agentIndex: 0, label: agents[0].label, event: 'heartbeat', toolCallCount: 0, note: 'awaiting model' });
      onProgress({ agentIndex: 0, label: agents[0].label, event: 'tool_call', toolCallCount: 2 });
      onProgress({ agentIndex: 1, label: agents[1].label, event: 'tool_call', toolCallCount: 3 });
      return {
        results: [
          {
            label: agents[0].label,
            reason: 'completed',
            finalText: 'A summary',
            usage: { input_tokens: 5, output_tokens: 1 },
            sandboxViolations: [],
            toolCallCount: 2,
          },
          {
            label: agents[1].label,
            reason: 'completed',
            finalText: 'B summary',
            usage: { input_tokens: 7, output_tokens: 2 },
            sandboxViolations: [],
            toolCallCount: 3,
          },
        ],
        totalUsage: { input_tokens: 12, output_tokens: 3 },
      };
    });

    const { tool, ctx, runner } = setup([
      task({ id: 'tsk_a', title: 'A', parallel_group: 'p' }),
      task({ id: 'tsk_b', title: 'B', parallel_group: 'p' }),
    ]);
    const result = await tool.handler({}, ctx);

    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('tools=2');
    expect(result.content).toContain('tools=3');
    expect(runner.emit).toHaveBeenCalledWith(
      'task_run_task_started',
      expect.objectContaining({ task_id: 'tsk_a' }),
    );
    expect(runner.emit).toHaveBeenCalledWith(
      'task_run_task_started',
      expect.objectContaining({ task_id: 'tsk_b' }),
    );
    expect(runner.emit).toHaveBeenCalledWith(
      'task_run_task_progress',
      expect.objectContaining({ task_id: 'tsk_a', tool_call_count: 0, note: 'awaiting model' }),
    );
    expect(runner.emit).toHaveBeenCalledWith(
      'task_run_task_progress',
      expect.objectContaining({ task_id: 'tsk_a', tool_call_count: 2 }),
    );
    expect(runner.emit).toHaveBeenCalledWith(
      'task_run_task_progress',
      expect.objectContaining({ task_id: 'tsk_b', tool_call_count: 3 }),
    );
  });

  it('opens inline scope instead of spawning subagent when execution_mode=inline (PR-G)', async () => {
    const { tool, ctx, runner } = setup(
      [task({ id: 'tsk_inline', title: 'Inline', suggested_mode: 'inline' })],
      { execution_mode: 'inline' },
    );

    const result = await tool.handler({}, ctx);

    // PR-G: no longer refuses. Opens the inline scope on the parent
    // runner and returns instructive text. Run stays "running" (no
    // task_run_finished emit) until task_complete fires.
    expect(result.isError).toBeFalsy();
    expect(runSubagent).not.toHaveBeenCalled();
    expect(runner.beginTaskScope).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'tsk_inline' }),
    );
    expect(runner.emit).toHaveBeenCalledWith(
      'task_started',
      expect.objectContaining({ task_id: 'tsk_inline', mode: 'inline' }),
    );
    // Run is paused (NOT finished) — agent must call task_complete next.
    const finished = runner.emit.mock.calls.filter((c) => c[0] === 'task_run_finished');
    expect(finished.length).toBe(0);
  });

  it('continues independent tasks and skips dependents after a task fails', async () => {
    let call = 0;
    vi.mocked(runSubagent).mockImplementation(async () => {
      call++;
      if (call === 1) {
        return {
          reason: 'error',
          finalText: 'A failed',
          usage: { input_tokens: 1, output_tokens: 1 },
          sandboxViolations: [],
        };
      }
      return {
        reason: 'completed',
        finalText: 'B done',
        usage: { input_tokens: 2, output_tokens: 2 },
        sandboxViolations: [],
      };
    });

    const { tool, ctx, runner } = setup([
      task({ id: 'tsk_a', title: 'A' }),
      task({ id: 'tsk_b', title: 'B' }),
      task({ id: 'tsk_c', title: 'C depends on A', depends_on: ['tsk_a'] }),
    ]);

    const result = await tool.handler({}, ctx);

    expect(result.isError).toBe(true);
    expect(runSubagent).toHaveBeenCalledTimes(2);
    expect(result.content).toContain('tsk_a');
    expect(result.content).toContain('status=failed');
    expect(result.content).toContain('tsk_b');
    expect(result.content).toContain('status=done');
    expect(result.content).toContain('tsk_c');
    expect(result.content).toContain('status=skipped');
    expect(runner.emit).toHaveBeenCalledWith(
      'task_run_finished',
      expect.objectContaining({ status: 'failed' }),
    );
  });
});
