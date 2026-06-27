import { describe, expect, it } from 'vitest';
import type { ToolContext } from '@mcp/code-agent/core/tool.js';
import type { CoderTask, TasksState } from '@mcp/code-agent/sessions/types.js';
import {
  cancelTasks,
  deleteTasks,
  listTasks,
  validateTasksInput,
} from '../tasks.js';

function task(overrides: Partial<CoderTask> = {}): CoderTask {
  return {
    id: 'tsk_base',
    title: 'Base task',
    description: 'Do the base task',
    files: ['src/base.ts'],
    references: [],
    depends_on: [],
    suggested_mode: 'inline',
    estimated_complexity: 'medium',
    kind: 'implement',
    status: 'pending',
    ...overrides,
  };
}

function toolContext(stateRef: { state: TasksState | null }): ToolContext {
  const runner = {
    emit: () => undefined,
    currentTaskScopeId: () => null,
    endTaskScope: () => undefined,
  };
  return {
    cwd: 'D:/MCP',
    projectName: 'test',
    runner,
    getTasksState: () => stateRef.state,
    recordTasks: (_toolUseId: string, next: TasksState) => {
      stateRef.state = next;
    },
    updateTaskStatus: (taskId: string, patch: Partial<CoderTask>) => {
      if (!stateRef.state) return null;
      const idx = stateRef.state.tasks.findIndex((t) => t.id === taskId);
      if (idx < 0) return null;
      const next: TasksState = {
        ...stateRef.state,
        tasks: stateRef.state.tasks.map((t, i) => (i === idx ? { ...t, ...patch } : t)),
        current_task_id:
          patch.status === 'running'
            ? taskId
            : (patch.status === 'done' || patch.status === 'failed' || patch.status === 'skipped')
                && stateRef.state.current_task_id === taskId
              ? null
              : stateRef.state.current_task_id,
      };
      stateRef.state = next;
      return next;
    },
  } as unknown as ToolContext;
}

describe('task id generation', () => {
  it('replaces client aliases with generated ids and rewrites dependencies', () => {
    const result = validateTasksInput({
      summary: 'Split work',
      tasks: [
        {
          id: 'task_1',
          title: 'First',
          description: 'Do first',
          files: ['src/first.ts'],
          suggested_mode: 'inline',
          estimated_complexity: 'small',
        },
        {
          id: 'task_2',
          title: 'Second',
          description: 'Do second',
          files: ['src/second.ts'],
          depends_on: ['task_1'],
          suggested_mode: 'inline',
          estimated_complexity: 'small',
        },
      ],
    });

    expect(typeof result).not.toBe('string');
    if (typeof result === 'string') throw new Error(result);
    expect(result.tasks).toHaveLength(2);
    expect(result.tasks[0].id).toMatch(/^tsk_[0-9a-f]{8}$/);
    expect(result.tasks[1].id).toMatch(/^tsk_[0-9a-f]{8}$/);
    expect(result.tasks[0].id).not.toBe('task_1');
    expect(result.tasks[1].depends_on).toEqual([result.tasks[0].id]);
  });

  it('generates stable dependency aliases when ids are omitted', () => {
    const result = validateTasksInput({
      summary: 'Implicit aliases',
      tasks: [
        {
          title: 'First',
          description: 'Do first',
          files: ['src/first.ts'],
          suggested_mode: 'inline',
          estimated_complexity: 'small',
        },
        {
          title: 'Second',
          description: 'Do second',
          files: ['src/second.ts'],
          depends_on: ['task_1'],
          suggested_mode: 'inline',
          estimated_complexity: 'small',
        },
      ],
    });

    expect(typeof result).not.toBe('string');
    if (typeof result === 'string') throw new Error(result);
    expect(result.tasks[0].id).toMatch(/^tsk_[0-9a-f]{8}$/);
    expect(result.tasks[1].id).toMatch(/^tsk_[0-9a-f]{8}$/);
    expect(new Set(result.tasks.map((t) => t.id)).size).toBe(2);
    expect(result.tasks[1].depends_on).toEqual([result.tasks[0].id]);
  });

  it('rejects duplicate client aliases before generating ids', () => {
    const result = validateTasksInput({
      summary: 'Duplicate aliases',
      tasks: [
        {
          id: 'same',
          title: 'First',
          description: 'Do first',
          files: ['src/first.ts'],
          suggested_mode: 'inline',
          estimated_complexity: 'small',
        },
        {
          id: 'same',
          title: 'Second',
          description: 'Do second',
          files: ['src/second.ts'],
          suggested_mode: 'inline',
          estimated_complexity: 'small',
        },
      ],
    });

    expect(result).toBe('duplicate task id: same');
  });
});

describe('task list tools', () => {
  it('lists generated ids for the current task state', async () => {
    const stateRef: { state: TasksState | null } = {
      state: {
        summary: 'Current tasks',
        approved: true,
        execution_mode: 'inline',
        current_task_id: null,
        tasks: [
          task({ id: 'tsk_alpha', title: 'Alpha' }),
          task({ id: 'tsk_beta', title: 'Beta', status: 'done' }),
        ],
      } satisfies TasksState,
    };

    const result = await listTasks.handler({}, toolContext(stateRef));
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('id=tsk_alpha');
    expect(result.content).toContain('id=tsk_beta');
  });

  it('deletes tasks and strips dependencies pointing at deleted ids', async () => {
    const stateRef: { state: TasksState | null } = {
      state: {
        summary: 'Current tasks',
        approved: true,
        execution_mode: 'inline',
        current_task_id: null,
        tasks: [
          task({ id: 'tsk_alpha', title: 'Alpha' }),
          task({ id: 'tsk_beta', title: 'Beta', depends_on: ['tsk_alpha'] }),
        ],
      } satisfies TasksState,
    };

    const result = await deleteTasks.handler({ task_ids: ['tsk_alpha'] }, toolContext(stateRef));
    expect(result.isError).toBeFalsy();
    expect(stateRef.state?.tasks.map((t) => t.id)).toEqual(['tsk_beta']);
    expect(stateRef.state?.tasks[0].depends_on).toEqual([]);
  });

  it('cancels non-terminal tasks while preserving done tasks', async () => {
    const stateRef: { state: TasksState | null } = {
      state: {
        summary: 'Current tasks',
        approved: true,
        execution_mode: 'inline',
        current_task_id: 'tsk_beta',
        tasks: [
          task({ id: 'tsk_alpha', title: 'Alpha', status: 'done' }),
          task({ id: 'tsk_beta', title: 'Beta', status: 'running' }),
          task({ id: 'tsk_gamma', title: 'Gamma', status: 'failed' }),
        ],
      } satisfies TasksState,
    };

    const result = await cancelTasks.handler({ all: true, reason: 'New round.' }, toolContext(stateRef));
    expect(result.isError).toBeFalsy();
    expect(stateRef.state?.tasks.map((t) => [t.id, t.status])).toEqual([
      ['tsk_alpha', 'done'],
      ['tsk_beta', 'skipped'],
      ['tsk_gamma', 'skipped'],
    ]);
    expect(stateRef.state?.current_task_id).toBeNull();
  });
});
