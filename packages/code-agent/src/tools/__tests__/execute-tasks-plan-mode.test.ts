/**
 * Plan-mode handling for execute_tasks. The plan gate now lets execute_tasks
 * reach its handler unapproved (see isPlanModeWorkflowTool); the handler drives
 * the human-gated plan→build transition instead of dead-ending.
 *
 * Three behaviors:
 *  - no approved list + user rejects → guidance, no transition;
 *  - no approved list + user approves → switch to build, no waves run;
 *  - already-approved list → no second prompt, transition + waves run.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { newSessionId } from '@mcp/session-storage';
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

interface SetupOpts {
  /** Tasks state returned by getTasksState (undefined = the model skipped submit_tasks). */
  state?: TasksState;
  /** JSON the runner's waitForUserInput resolves with. */
  userInput?: string;
}

function setup(opts: SetupOpts = {}) {
  let planApproved = false;
  const runner = {
    emit: vi.fn(),
    sessionId: newSessionId(),
    agentId: 'plan' as const,
    planMode: true,
    agentLoopV2: false,
    beginTaskScope: vi.fn(),
    currentTaskScopeId: vi.fn(() => null),
    approvePlan: vi.fn(() => {
      planApproved = true;
    }),
    isPlanApproved: vi.fn(() => planApproved),
    waitForUserInput: vi.fn(async () => opts.userInput ?? '{"approved":false}'),
  };
  const ctx = {
    cwd: 'D:/MCP',
    projectName: 'test',
    runner,
    getTasksState: () => opts.state,
    recordPlan: vi.fn(),
    resolvePlan: vi.fn(),
    setSessionAgent: vi.fn(),
    updateTaskStatus: vi.fn(),
    reportProgress: vi.fn(),
  } as unknown as ToolContext;
  const tool = buildExecuteTasksTool({
    provider: {} as never,
    parentTools: [],
    sessionStore: undefined,
    executeTasksRetryConfig: { maxRetries: 0, initialMs: 0, maxMs: 0, jitter: 0 },
  });
  return { tool, ctx, runner };
}

function approvedState(tasks: CoderTask[]): TasksState {
  return {
    summary: 'Run tasks',
    tasks,
    execution_mode: 'all-subagent',
    approved: true,
    current_task_id: null,
  };
}

beforeEach(() => {
  vi.mocked(runSubagent).mockReset();
});

describe('execute_tasks — plan mode', () => {
  it('presents the plan and does NOT transition when the user rejects', async () => {
    const { tool, ctx, runner } = setup({ userInput: '{"approved":false,"feedback":"need more detail"}' });

    const result = await tool.handler({}, ctx);

    expect(runner.emit).toHaveBeenCalledWith('plan_posted', expect.objectContaining({ type: 'plan' }));
    expect(result.isError).toBeFalsy();
    expect(result.content).toMatch(/rejected/i);
    expect(runner.approvePlan).not.toHaveBeenCalled();
    expect(ctx.setSessionAgent).not.toHaveBeenCalled();
    expect(runSubagent).not.toHaveBeenCalled();
  });

  it('switches to build (no waves) when the user approves with no task list', async () => {
    const { tool, ctx, runner } = setup({ userInput: '{"approved":true}' });

    const result = await tool.handler({}, ctx);

    expect(runner.approvePlan).toHaveBeenCalledOnce();
    expect(ctx.setSessionAgent).toHaveBeenCalledWith('build');
    expect(result.content).toMatch(/build mode/i);
    const firstBlock = result.extraUserBlocks?.[0];
    expect(firstBlock?.type).toBe('text');
    expect(firstBlock?.type === 'text' ? firstBlock.text : '').toMatch(/Plan → Build/);
    expect(runSubagent).not.toHaveBeenCalled();
  });

  it('runs the waves without a second prompt when a task list is already approved', async () => {
    vi.mocked(runSubagent).mockResolvedValue({
      reason: 'completed',
      finalText: 'done',
      usage: { input_tokens: 1, output_tokens: 1 },
      sandboxViolations: [],
    });
    const { tool, ctx, runner } = setup({ state: approvedState([task({ id: 'tsk_one', title: 'One' })]) });

    const result = await tool.handler({}, ctx);

    // The submit_tasks approval WAS the human gate — no re-prompt.
    expect(runner.waitForUserInput).not.toHaveBeenCalled();
    expect(runner.approvePlan).toHaveBeenCalledOnce();
    expect(ctx.setSessionAgent).toHaveBeenCalledWith('build');
    // ...and the waves actually ran.
    expect(runSubagent).toHaveBeenCalled();
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('tsk_one');
  });
});
