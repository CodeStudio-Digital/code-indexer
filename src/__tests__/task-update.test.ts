import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { tasksTools, _resetSubmitBurstForKey } from '@mcp/code-agent/tools/tasks.js';
import type { CoderTool, ToolContext } from '@mcp/code-agent/core/tool.js';
import type { CoderTask, TasksState } from '@mcp/session-storage/session-state-types.js';

const updateTask = tasksTools.find((t) => t.name === 'update_task') as CoderTool;
const submitTasks = tasksTools.find((t) => t.name === 'submit_tasks') as CoderTool;

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

function makeCtx(initial: TasksState) {
  const stateRef: { current: TasksState } = { current: initial };
  const runner = new EventEmitter();
  const ctx = {
    cwd: '/tmp',
    projectName: 'test',
    runner,
    getTasksState: () => stateRef.current,
    updateTaskStatus: vi.fn((taskId: string, patch: Partial<CoderTask>) => {
      const idx = stateRef.current.tasks.findIndex((t) => t.id === taskId);
      if (idx < 0) return null;
      const merged: CoderTask = { ...stateRef.current.tasks[idx], ...patch };
      stateRef.current = {
        ...stateRef.current,
        tasks: stateRef.current.tasks.map((t, i) => (i === idx ? merged : t)),
      };
      return stateRef.current;
    }),
  } as unknown as ToolContext;
  return { ctx, stateRef, runner };
}

describe('update_task — happy paths', () => {
  it('skips a pending task', async () => {
    const { ctx, stateRef } = makeCtx({
      approved: true,
      execution_mode: 'inline',
      summary: 'x',
      current_task_id: null,
      tasks: [task({ id: 'task_1', title: 'Drop me', status: 'pending' })],
    });
    const r = await updateTask.handler({ task_id: 'task_1', status: 'skipped' }, ctx);
    expect(r.isError).toBeFalsy();
    expect(stateRef.current.tasks[0].status).toBe('skipped');
  });

  it('retries a failed task by moving it back to pending', async () => {
    const { ctx, stateRef } = makeCtx({
      approved: true,
      execution_mode: 'inline',
      summary: 'x',
      current_task_id: null,
      tasks: [task({ id: 'task_1', title: 'Retry me', status: 'failed' })],
    });
    const r = await updateTask.handler({ task_id: 'task_1', status: 'pending' }, ctx);
    expect(r.isError).toBeFalsy();
    expect(stateRef.current.tasks[0].status).toBe('pending');
  });

  it('adds and removes files from the scope without touching other fields', async () => {
    const { ctx, stateRef } = makeCtx({
      approved: true,
      execution_mode: 'inline',
      summary: 'x',
      current_task_id: null,
      tasks: [task({ id: 'task_1', title: 'Scope', files: ['a.ts', 'b.ts'] })],
    });
    const r = await updateTask.handler(
      { task_id: 'task_1', files_add: ['c.ts'], files_remove: ['b.ts'] },
      ctx,
    );
    expect(r.isError).toBeFalsy();
    expect(stateRef.current.tasks[0].files).toEqual(['a.ts', 'c.ts']);
  });

  it('emits task_updated so the dashboard sidebar can refresh immediately', async () => {
    const { ctx, runner } = makeCtx({
      approved: true,
      execution_mode: 'inline',
      summary: 'x',
      current_task_id: null,
      tasks: [task({ id: 'task_1', title: 'X', status: 'pending' })],
    });
    const seen: Array<{ task_id: string }> = [];
    runner.on('task_updated', (payload: { task_id: string }) => seen.push(payload));
    await updateTask.handler({ task_id: 'task_1', status: 'skipped' }, ctx);
    expect(seen).toHaveLength(1);
    expect(seen[0].task_id).toBe('task_1');
  });
});

describe('update_task — error paths', () => {
  it('returns a recoverable error for unknown task_id', async () => {
    const { ctx } = makeCtx({
      approved: true,
      execution_mode: 'inline',
      summary: 'x',
      current_task_id: null,
      tasks: [task({ id: 'task_1', title: 'X' })],
    });
    const unknownId = 'tsk_00000099';
    const r = await updateTask.handler({ task_id: unknownId, status: 'skipped' }, ctx);
    expect(r.isError).toBe(true);
    expect(r.content).toContain(`unknown task_id '${unknownId}'`);
    expect(r.content).toContain('id=task_1');
  });

  it('refuses transitions reserved for execute_task / task_complete', async () => {
    const { ctx } = makeCtx({
      approved: true,
      execution_mode: 'inline',
      summary: 'x',
      current_task_id: null,
      tasks: [task({ id: 'task_1', title: 'X', status: 'pending' })],
    });
    // 'running' and 'done' must not be settable via update_task.
    const r1 = await updateTask.handler({ task_id: 'task_1', status: 'running' as unknown as string }, ctx);
    expect(r1.isError).toBe(true);
    expect(r1.content).toContain("must be 'pending' or 'skipped'");
  });

  it('refuses an illegal transition (e.g. done → pending)', async () => {
    const { ctx } = makeCtx({
      approved: true,
      execution_mode: 'inline',
      summary: 'x',
      current_task_id: null,
      tasks: [task({ id: 'task_1', title: 'X', status: 'done' })],
    });
    const r = await updateTask.handler({ task_id: 'task_1', status: 'pending' }, ctx);
    expect(r.isError).toBe(true);
    expect(r.content).toContain("cannot move task 'task_1' from 'done'");
  });

  it('errors when no task list exists', async () => {
    const runner = new EventEmitter();
    const ctx = {
      cwd: '/tmp',
      projectName: 'test',
      runner,
      getTasksState: () => null,
    } as unknown as ToolContext;
    const r = await updateTask.handler({ task_id: 'task_1', status: 'skipped' }, ctx);
    expect(r.isError).toBe(true);
    expect(r.content).toContain('no task list exists in this session');
    expect(r.content).not.toContain('submit_tasks');
  });

  it('requires at least one mutating field', async () => {
    const { ctx } = makeCtx({
      approved: true,
      execution_mode: 'inline',
      summary: 'x',
      current_task_id: null,
      tasks: [task({ id: 'task_1', title: 'X' })],
    });
    const r = await updateTask.handler({ task_id: 'task_1' }, ctx);
    expect(r.isError).toBe(true);
    expect(r.content).toContain('at least one of');
  });
});

describe('submit_tasks — burst guard', () => {
  function makeSubmitCtx() {
    const runner = new EventEmitter() as unknown as ToolContext['runner'] & {
      waitForUserInput: () => Promise<string>;
    };
    // submit_tasks awaits user input — short-circuit with an aborted verdict so
    // the handler returns synchronously after emitting the burst guard or
    // initial pause.
    (runner as unknown as { waitForUserInput: () => Promise<string> }).waitForUserInput = async () =>
      JSON.stringify({ aborted: true });
    const ctx = {
      cwd: '/tmp',
      projectName: 'test',
      runner,
      recordTasks: vi.fn(),
      resolveTasks: vi.fn(),
      getTasksState: () => null,
    } as unknown as ToolContext;
    return { ctx, runner };
  }

  it('refuses on the 4th identical submission inside the window', async () => {
    const { ctx, runner } = makeSubmitCtx();
    _resetSubmitBurstForKey(runner as unknown as object);
    const args = {
      summary: 'do the work',
      tasks: [
        { id: 'task_1', title: 'A', description: 'a', files: ['a.ts'], suggested_mode: 'inline', estimated_complexity: 'small', depends_on: [] },
        { id: 'task_2', title: 'B', description: 'b', files: ['b.ts'], suggested_mode: 'inline', estimated_complexity: 'small', depends_on: [] },
      ],
    };
    for (let i = 0; i < 3; i++) {
      const r = await submitTasks.handler(args, ctx);
      // The first three are accepted (and then aborted via the stub user verdict).
      expect(r.isError).toBe(true); // because of aborted verdict — but NOT a burst-guard refusal.
      expect(r.content).not.toContain('Refused');
    }
    const fourth = await submitTasks.handler(args, ctx);
    expect(fourth.isError).toBe(true);
    expect(fourth.content).toContain('Refused');
    expect(fourth.content).toContain('update_task');
  });

  it('resets the counter when the signature changes (new task added)', async () => {
    const { ctx, runner } = makeSubmitCtx();
    _resetSubmitBurstForKey(runner as unknown as object);
    const baseArgs = {
      summary: 'do the work',
      tasks: [
        { id: 'task_1', title: 'A', description: 'a', files: ['a.ts'], suggested_mode: 'inline', estimated_complexity: 'small', depends_on: [] },
        { id: 'task_2', title: 'B', description: 'b', files: ['b.ts'], suggested_mode: 'inline', estimated_complexity: 'small', depends_on: [] },
      ],
    };
    for (let i = 0; i < 3; i++) {
      await submitTasks.handler(baseArgs, ctx);
    }
    const expandedArgs = {
      summary: 'do the work',
      tasks: [
        ...baseArgs.tasks,
        { id: 'task_3', title: 'C', description: 'c', files: ['c.ts'], suggested_mode: 'inline', estimated_complexity: 'small', depends_on: [] },
      ],
    };
    const r = await submitTasks.handler(expandedArgs, ctx);
    expect(r.content).not.toContain('Refused');
  });
});
