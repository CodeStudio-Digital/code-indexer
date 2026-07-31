import { describe, expect, it } from 'vitest';
import type { ToolContext } from '@mcp/code-agent/core/tool.js';
import type { CoderTask, TasksState } from '@mcp/code-agent/sessions/types.js';
import { taskList } from '../tasks.js';
import {
  buildTrackState,
  deriveTodosFromState,
  effectiveGate,
  type TodoItem,
} from '../task-list-shared.js';

/**
 * task_list is the unified front door (merge of todo_write/update_todo +
 * submit_tasks). These tests exercise the dispatcher: gate inference, the
 * track (checklist) write/patch paths, the data-safety guard that refuses
 * clobbering an active approve list, and the approve dispatch.
 */

function approveTask(overrides: Partial<CoderTask> = {}): CoderTask {
  return {
    id: 'tsk_a',
    title: 'Approve task',
    description: 'Do the structured task',
    files: ['src/a.ts'],
    references: [],
    depends_on: [],
    suggested_mode: 'subagent',
    estimated_complexity: 'medium',
    kind: 'implement',
    status: 'pending',
    ...overrides,
  };
}

interface Harness {
  ctx: ToolContext;
  stateRef: { state: TasksState | null };
  userInput: string;
  waitCount: number;
}

function makeHarness(initial: TasksState | null = null, planMode = true): Harness {
  const stateRef = { state: initial };
  const h: Harness = {
    ctx: null as unknown as ToolContext,
    stateRef,
    userInput: '{"approved":true,"execution_mode":"inline"}',
    waitCount: 0,
  };
  const runner = {
    planMode,
    emit: () => undefined,
    currentTaskScopeId: () => null,
    endTaskScope: () => undefined,
    // Track gate: setTodos persists a track-gate state, currentTodos derives it
    // — mirrors the real runner so the todo_write/update_todo handlers behave.
    setTodos: (todos: TodoItem[]) => { stateRef.state = buildTrackState(todos); },
    get currentTodos(): TodoItem[] { return deriveTodosFromState(stateRef.state); },
    // Approve gate: submit_tasks pauses on waitForUserInput then resolves.
    waitForUserInput: async () => {
      h.waitCount += 1;
      return h.userInput;
    },
    markTasksApproved: () => undefined,
  };
  h.ctx = {
    cwd: 'D:/MCP',
    projectName: 'test',
    planMode,
    runner,
    getTasksState: () => stateRef.state,
    recordTasks: (_id: string, next: TasksState) => { stateRef.state = next; },
    resolveTasks: (verdict: { approved: boolean; tasks?: CoderTask[]; execution_mode?: TasksState['execution_mode'] }) => {
      if (!stateRef.state) return;
      stateRef.state = {
        ...stateRef.state,
        approved: verdict.approved,
        execution_mode: verdict.execution_mode ?? stateRef.state.execution_mode,
        tasks: verdict.tasks ?? stateRef.state.tasks,
      };
    },
  } as unknown as ToolContext;
  return h;
}

describe('task_list — gate inference + track path', () => {
  it('infers track gate for checklist-shaped items and writes a track list', async () => {
    const h = makeHarness();
    const res = await taskList.handler(
      { items: [
        { content: 'Run tests', activeForm: 'Running tests', status: 'pending' },
        { content: 'Write docs', activeForm: 'Writing docs', status: 'pending' },
      ] },
      h.ctx,
    );
    expect(res.isError).toBeFalsy();
    expect(effectiveGate(h.stateRef.state)).toBe('track');
    expect(h.stateRef.state?.tasks).toHaveLength(2);
    expect(h.stateRef.state?.tasks[0].content).toBe('Run tests');
  });

  it('updates patches an existing checklist item by id', async () => {
    const h = makeHarness();
    await taskList.handler(
      { gate: 'track', items: [{ id: 'aaaa1111', content: 'Step one', activeForm: 'Doing step one', status: 'pending' }] },
      h.ctx,
    );
    const res = await taskList.handler({ updates: [{ id: 'aaaa1111', status: 'in_progress' }] }, h.ctx);
    expect(res.isError).toBeFalsy();
    const todos = deriveTodosFromState(h.stateRef.state);
    expect(todos[0].status).toBe('in_progress');
  });
});

describe('task_list — gate inference + approve path', () => {
  it('refuses an approve gate immediately in Build mode instead of waiting for user input', async () => {
    const h = makeHarness(null, false);
    const res = await taskList.handler(
      { gate: 'approve', summary: 'Do two things', items: [
        approveTask({ id: 'a1', title: 'One' }),
        approveTask({ id: 'a2', title: 'Two', files: ['src/b.ts'] }),
      ] },
      h.ctx,
    );
    expect(res.isError).toBe(true);
    expect(String(res.content)).toMatch(/only in Plan mode/i);
    expect(h.waitCount).toBe(0);
    expect(h.stateRef.state).toBeNull();
  });

  it('routes a title-bearing item (gate omitted) to the approve path, not the misleading todo error', async () => {
    const h = makeHarness();
    // A single under-specified approve item: `title` is the discriminator, so it
    // must infer approve → submitTasks validation (which complains about the
    // approve shape: needs 2+ / submit_plan), NOT todoWrite's "content cannot be empty".
    const res = await taskList.handler({ items: [{ title: 'Do the thing' }] }, h.ctx);
    expect(res.isError).toBe(true);
    // Hit the approve validator (submit_tasks), NOT todoWrite's content error.
    expect(String(res.content)).not.toMatch(/content cannot be empty/i);
    expect(String(res.content)).toMatch(/submit_tasks validation|submit_plan|2\+/i);
  });

  it('infers approve gate for structured items and pauses → approves', async () => {
    const h = makeHarness();
    const res = await taskList.handler(
      { summary: 'Do two things', items: [
        approveTask({ id: 'a1', title: 'One' }),
        approveTask({ id: 'a2', title: 'Two', files: ['src/b.ts'] }),
      ] },
      h.ctx,
    );
    expect(res.isError).toBeFalsy();
    expect(effectiveGate(h.stateRef.state)).toBe('approve');
    expect(h.stateRef.state?.approved).toBe(true);
  });
});

describe('task_list — data-safety guard', () => {
  it('refuses a track write while an active approve list exists', async () => {
    // Active approve list: approved, with a pending task.
    const approveState: TasksState = {
      gate: 'approve',
      summary: 'Approved work',
      tasks: [approveTask({ id: 'tsk_live', status: 'pending' })],
      execution_mode: 'inline',
      approved: true,
      current_task_id: null,
    };
    const h = makeHarness(approveState);
    const res = await taskList.handler(
      { gate: 'track', items: [{ content: 'sneaky checklist', activeForm: 'sneaking', status: 'pending' }] },
      h.ctx,
    );
    expect(res.isError).toBe(true);
    expect(String(res.content)).toMatch(/approved task list is still active/i);
    // The approve list must be untouched.
    expect(effectiveGate(h.stateRef.state)).toBe('approve');
    expect(h.stateRef.state?.tasks[0].id).toBe('tsk_live');
  });

  it('allows a track write when the approve list is terminal (all done)', async () => {
    const doneState: TasksState = {
      gate: 'approve',
      summary: 'Finished work',
      tasks: [approveTask({ id: 'tsk_done', status: 'done' })],
      execution_mode: 'inline',
      approved: true,
      current_task_id: null,
    };
    const h = makeHarness(doneState);
    const res = await taskList.handler(
      { gate: 'track', items: [{ content: 'next checklist', activeForm: 'doing next', status: 'pending' }] },
      h.ctx,
    );
    expect(res.isError).toBeFalsy();
    expect(effectiveGate(h.stateRef.state)).toBe('track');
  });
});
