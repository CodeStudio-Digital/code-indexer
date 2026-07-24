/**
 * PR-G: smart inline handling in execute_tasks.
 *
 * Replaces the PR-A reject-reason behavior (recusa rude) with a smart
 * flow: when there's at least one inline-mode task to run, execute_tasks
 *
 *   1. Dispatches every SUBAGENT task in the current wave-group first
 *      (in parallel).
 *   2. Opens the task scope on the parent runner for the FIRST inline
 *      task and returns a clear instruction telling the agent to work
 *      + call task_complete + re-invoke execute_tasks to continue.
 *
 * The dashboard sees the run as still 'running' (no task_run_finished
 * emit) so the kanban / timeline stay accurate.
 *
 * Also pins the "scope already active" guard: a second execute_tasks
 * call while a prior inline scope is still open returns a refusal with
 * the active task id so the agent knows exactly what to close.
 */
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
const { runSubagent } = await import('../implement-subagent.js');

function task(overrides: Partial<CoderTask> = {}): CoderTask {
  return {
    id: 'tsk_base', title: 'Base', description: 'desc',
    files: ['src/base.ts'], references: [], depends_on: [],
    suggested_mode: 'inline', estimated_complexity: 'medium',
    kind: 'implement', status: 'pending',
    ...overrides,
  };
}

function setup(tasks: CoderTask[], opts: { execution_mode?: TasksState['execution_mode']; activeScopeId?: string | null } = {}) {
  const runner = {
    emit: vi.fn(),
    sessionId: 123,
    agentLoopV2: false,
    beginTaskScope: vi.fn(),
    currentTaskScopeId: vi.fn(() => opts.activeScopeId ?? null),
  };
  const state: TasksState = {
    summary: 'Run inline',
    tasks,
    execution_mode: opts.execution_mode ?? 'inline',
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
    sessionStore: undefined,
  });
  return { tool, ctx, runner };
}

beforeEach(() => {
  vi.mocked(runSubagent).mockReset();
  vi.stubEnv('CODER_TASK_MAX_RETRIES', '0');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('execute_tasks — inline scope (PR-G)', () => {
  it('opens scope on the FIRST inline task and returns instructive text', async () => {
    const { tool, ctx, runner } = setup([task({ id: 'tsk_one' })]);
    const result = await tool.handler({}, ctx);

    expect(result.isError).toBeFalsy();
    expect(runner.beginTaskScope).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'tsk_one' }),
    );
    expect(result.content).toContain("Inline task scope ACTIVE for 'tsk_one'");
    expect(result.content).toContain('task_complete(task_id="tsk_one"');
    expect(result.content).toContain('last inline task');
    // No subagent dispatch.
    expect(runSubagent).not.toHaveBeenCalled();
  });

  it('emits task_started with mode="inline" (not subagent)', async () => {
    const { tool, ctx, runner } = setup([task({ id: 'tsk_one' })]);
    await tool.handler({}, ctx);
    expect(runner.emit).toHaveBeenCalledWith(
      'task_started',
      expect.objectContaining({ task_id: 'tsk_one', mode: 'inline' }),
    );
  });

  it('does NOT emit task_run_finished while scope is open (run still running)', async () => {
    const { tool, ctx, runner } = setup([task({ id: 'tsk_one' })]);
    await tool.handler({}, ctx);
    const finishedEmits = runner.emit.mock.calls.filter((c) => c[0] === 'task_run_finished');
    expect(finishedEmits.length).toBe(0);
  });

  it('tells the agent how many more inline tasks are pending', async () => {
    const { tool, ctx } = setup([
      task({ id: 'tsk_1' }),
      task({ id: 'tsk_2' }),
      task({ id: 'tsk_3' }),
    ]);
    const result = await tool.handler({}, ctx);
    // Opens scope on tsk_1 → reports 2 more pending.
    expect(result.content).toMatch(/2 more inline task\(s\) pending/);
  });

  it('updateTaskStatus marks the opened task as running+inline', async () => {
    const { tool, ctx } = setup([task({ id: 'tsk_one' })]);
    await tool.handler({}, ctx);
    expect(ctx.updateTaskStatus).toHaveBeenCalledWith(
      'tsk_one',
      expect.objectContaining({ status: 'running', mode_used: 'inline' }),
    );
  });
});

describe('execute_tasks — already-active scope guard', () => {
  it('refuses with actionable message when an inline scope is open', async () => {
    const { tool, ctx } = setup(
      [task({ id: 'tsk_other' })],
      { activeScopeId: 'tsk_busy' },
    );
    const result = await tool.handler({}, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('tsk_busy');
    expect(result.content).toContain('task_complete');
  });

  it('does not open a second scope while one is active', async () => {
    const { tool, ctx, runner } = setup(
      [task({ id: 'tsk_other' })],
      { activeScopeId: 'tsk_busy' },
    );
    await tool.handler({}, ctx);
    expect(runner.beginTaskScope).not.toHaveBeenCalled();
  });
});

describe('execute_tasks — mixed mode (PR-G)', () => {
  it('runs subagent tasks first, then opens inline scope', async () => {
    let i = 0;
    const callOrder: string[] = [];
    vi.mocked(runSubagent).mockImplementation(async (_p, spec) => {
      i++;
      const firstBlock = spec.initialMessages[0]?.content[0];
      const text = firstBlock && firstBlock.type === 'text' ? firstBlock.text : '';
      callOrder.push(`subagent_${text.match(/Task (\w+)/)?.[1] ?? i}`);
      return {
        reason: 'completed', finalText: `done ${i}`,
        usage: { input_tokens: 1, output_tokens: 1 }, sandboxViolations: [],
      };
    });

    const { tool, ctx, runner } = setup([
      // Mixed: tsk_sub is subagent, tsk_inline is inline. Same wave (no deps).
      task({ id: 'tsk_sub', suggested_mode: 'subagent' }),
      task({ id: 'tsk_inline', suggested_mode: 'inline' }),
    ], { execution_mode: 'per-task' });

    runner.beginTaskScope.mockImplementation(() => {
      callOrder.push('beginTaskScope');
    });

    const result = await tool.handler({}, ctx);
    expect(result.isError).toBeFalsy();

    // Subagent ran BEFORE the inline scope was opened.
    const subIdx = callOrder.findIndex((c) => c.startsWith('subagent'));
    const scopeIdx = callOrder.indexOf('beginTaskScope');
    expect(subIdx).toBeGreaterThanOrEqual(0);
    expect(scopeIdx).toBeGreaterThan(subIdx);

    // Final return mentions the opened inline scope.
    expect(result.content).toContain('tsk_inline');
    expect(result.content).toContain("Inline task scope ACTIVE");
  });

  it('keeps the opened inline scope but reports a prior subagent failure as a tool error', async () => {
    vi.mocked(runSubagent).mockResolvedValue({
      reason: 'error',
      finalText: 'subagent failed before inline work',
      usage: { input_tokens: 1, output_tokens: 1 },
      sandboxViolations: [],
    });
    const { tool, ctx, runner } = setup([
      task({ id: 'tsk_sub', suggested_mode: 'subagent' }),
      task({ id: 'tsk_inline', suggested_mode: 'inline' }),
    ], { execution_mode: 'per-task' });

    const result = await tool.handler({}, ctx);

    expect(result.isError).toBe(true);
    expect(result.content).toContain('status=failed');
    expect(result.content).toContain("Inline task scope ACTIVE for 'tsk_inline'");
    expect(runner.beginTaskScope).toHaveBeenCalled();
  });

  it('per-task mode respects task.suggested_mode (not all subagent)', async () => {
    vi.mocked(runSubagent).mockResolvedValue({
      reason: 'completed', finalText: 'sub done',
      usage: { input_tokens: 1, output_tokens: 1 }, sandboxViolations: [],
    });

    const { tool, ctx, runner } = setup([
      task({ id: 'tsk_a', suggested_mode: 'subagent' }),
      task({ id: 'tsk_b', suggested_mode: 'inline' }),
    ], { execution_mode: 'per-task' });

    await tool.handler({}, ctx);

    // 1 subagent dispatched, 1 inline scope opened.
    expect(runSubagent).toHaveBeenCalledTimes(1);
    expect(runner.beginTaskScope).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'tsk_b' }),
    );
  });

  it('all-subagent execution_mode dispatches everything as subagent', async () => {
    vi.mocked(runSubagent).mockResolvedValue({
      reason: 'completed', finalText: 'ok',
      usage: { input_tokens: 1, output_tokens: 1 }, sandboxViolations: [],
    });

    const { tool, ctx, runner } = setup([
      task({ id: 'tsk_a', suggested_mode: 'inline' }), // inline preference IGNORED
      task({ id: 'tsk_b', suggested_mode: 'inline' }),
    ], { execution_mode: 'all-subagent' });

    await tool.handler({}, ctx);

    expect(runSubagent).toHaveBeenCalledTimes(2);
    expect(runner.beginTaskScope).not.toHaveBeenCalled();
  });

  it('mode="inline-all" arg overrides everything and forces inline scope', async () => {
    const { tool, ctx, runner } = setup([
      task({ id: 'tsk_a', suggested_mode: 'subagent' }), // subagent preference IGNORED
    ], { execution_mode: 'all-subagent' });

    await tool.handler({ mode: 'inline-all' }, ctx);

    expect(runSubagent).not.toHaveBeenCalled();
    expect(runner.beginTaskScope).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'tsk_a' }),
    );
  });
});
