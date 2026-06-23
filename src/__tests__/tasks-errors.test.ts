import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { executeTask } from '@mcp/code-agent/tools/tasks.js';
import type { ToolContext } from '@mcp/code-agent/core/tool.js';
import type { TasksState, CoderTask } from '@mcp/code-agent/sessions/types.js';

function task(partial: Partial<CoderTask> & { id: string; title: string }): CoderTask {
  return {
    description: '',
    files: [],
    references: [],
    depends_on: [],
    suggested_mode: 'inline',
    estimated_complexity: 'small',
    status: 'pending',
    ...partial,
  } as CoderTask;
}

function makeCtx(state: TasksState): ToolContext {
  const runner = new EventEmitter() as unknown as ToolContext['runner'];
  // The tool only inspects ctx.runner truthiness for the early-return guard;
  // we never reach the inline/subagent execution path because every test
  // here exercises an error branch.
  return {
    cwd: '/tmp',
    projectName: 'test',
    runner,
    getTasksState: () => state,
  } as unknown as ToolContext;
}

describe('execute_task — recoverable error messages', () => {
  it('lists valid pending IDs when task_id is unknown', async () => {
    const state: TasksState = {
      approved: true,
      execution_mode: 'inline',
      tasks: [
        task({ id: 'task_1', title: 'Refactor parser', status: 'pending' }),
        task({ id: 'task_2', title: 'Add tests', status: 'pending' }),
        task({ id: 'task_3', title: 'Wire DB', status: 'done' }),
      ],
    } as unknown as TasksState;

    const r = await executeTask.handler({ task_id: 'task_99' }, makeCtx(state));
    expect(r.isError).toBe(true);
    expect(r.content).toContain("unknown task_id 'task_99'");
    expect(r.content).toContain('Valid pending tasks:');
    expect(r.content).toContain('id=task_1 "Refactor parser"');
    expect(r.content).toContain('id=task_2 "Add tests"');
    // task_3 is done — should not appear in pending or failed sections.
    expect(r.content).not.toContain('id=task_3');
  });

  it('suggests "Did you mean" when the bad id is a near-miss', async () => {
    const state: TasksState = {
      approved: true,
      execution_mode: 'inline',
      tasks: [task({ id: 'task_refactor', title: 'Refactor parser', status: 'pending' })],
    } as unknown as TasksState;

    const r = await executeTask.handler({ task_id: 'task_refactr' }, makeCtx(state));
    expect(r.isError).toBe(true);
    expect(r.content).toContain("Did you mean 'task_refactor'");
  });

  it('does NOT suggest "Did you mean" when the bad id is far from any candidate', async () => {
    const state: TasksState = {
      approved: true,
      execution_mode: 'inline',
      tasks: [task({ id: 'a', title: 'Alpha', status: 'pending' })],
    } as unknown as TasksState;

    const r = await executeTask.handler({ task_id: 'completely_unrelated_xyz' }, makeCtx(state));
    expect(r.isError).toBe(true);
    expect(r.content).not.toContain('Did you mean');
  });

  it('lists failed tasks in their own section', async () => {
    const state: TasksState = {
      approved: true,
      execution_mode: 'inline',
      tasks: [
        task({ id: 'task_1', title: 'Pending one', status: 'pending' }),
        task({ id: 'task_2', title: 'Failed one', status: 'failed' }),
      ],
    } as unknown as TasksState;

    const r = await executeTask.handler({ task_id: 'task_99' }, makeCtx(state));
    expect(r.content).toContain('Valid pending tasks:');
    expect(r.content).toContain('Failed tasks (retryable):');
    expect(r.content).toContain('id=task_2 "Failed one"');
  });

  it('explains dependency-not-met with the depended-on title and status', async () => {
    const state: TasksState = {
      approved: true,
      execution_mode: 'inline',
      tasks: [
        task({ id: 'task_1', title: 'First', status: 'pending' }),
        task({
          id: 'task_2',
          title: 'Second',
          status: 'pending',
          depends_on: ['task_1'],
        }),
      ],
    } as unknown as TasksState;

    const r = await executeTask.handler({ task_id: 'task_2' }, makeCtx(state));
    expect(r.isError).toBe(true);
    expect(r.content).toContain("dependency 'task_1'");
    expect(r.content).toContain('"First"');
    expect(r.content).toContain("status 'pending'");
  });
});
