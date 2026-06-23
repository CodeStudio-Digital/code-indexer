import { describe, expect, it } from 'vitest';
import { deriveTaskCardState } from '../task-card-state.js';
import type { StreamTask } from '../../../../hooks/useAgentStream.js';
import type { PersistedTasksState } from '../../types.js';

function task(id: string, status: StreamTask['status'] = 'pending'): StreamTask {
  return {
    id,
    title: id,
    description: '',
    files: [],
    depends_on: [],
    suggested_mode: 'inline',
    estimated_complexity: 'small',
    status,
  };
}

const frozen: StreamTask[] = [task('frozen_1'), task('frozen_2')];

function rowState(over: Partial<PersistedTasksState> = {}): PersistedTasksState {
  return {
    summary: 'row',
    tasks: [task('tsk_a', 'done'), task('tsk_b', 'running')],
    execution_mode: 'inline',
    approved: false,
    current_task_id: null,
    ...over,
  };
}

describe('deriveTaskCardState', () => {
  it('active + approved row, no tool_result yet → approved, overlays live tasks', () => {
    const state = rowState({ approved: true });
    const { tasks, resolved } = deriveTaskCardState({
      isActive: true,
      frozenTasks: frozen,
      tasksState: state,
      result: undefined,
    });
    expect(resolved).toBe('approved'); // buttons hidden the instant approval persists
    expect(tasks).toBe(state.tasks); // live runtime status overlay
  });

  it('active + tool_result "Task list approved" → approved', () => {
    const { resolved } = deriveTaskCardState({
      isActive: true,
      frozenTasks: frozen,
      tasksState: rowState({ approved: true }),
      result: { content: 'Task list approved by user. Execution mode: inline.', isError: false },
    });
    expect(resolved).toBe('approved');
  });

  it('active + rejected tool_result → rejected (approved:false alone is ambiguous)', () => {
    const { resolved } = deriveTaskCardState({
      isActive: true,
      frozenTasks: frozen,
      tasksState: rowState({ approved: false }),
      result: { content: 'Task list rejected by user. Revise the tasks…', isError: false },
    });
    expect(resolved).toBe('rejected');
  });

  it('active + freshly posted (approved:false, no result) → undefined → buttons stay', () => {
    const state = rowState({ approved: false });
    const { tasks, resolved } = deriveTaskCardState({
      isActive: true,
      frozenTasks: frozen,
      tasksState: state,
      result: undefined,
    });
    expect(resolved).toBeUndefined();
    expect(tasks).toBe(state.tasks); // active card still overlays the current list
  });

  it('non-active card → renders its OWN frozen snapshot, ignores live row', () => {
    const { tasks, resolved } = deriveTaskCardState({
      isActive: false,
      frozenTasks: frozen,
      tasksState: rowState({ approved: true }), // would otherwise bleed in
      result: { content: 'Task list approved by user.', isError: false },
    });
    expect(tasks).toBe(frozen);
    expect(resolved).toBe('approved'); // from its own tool_result, not the row
  });

  it('non-active card without result → undefined (no row fallback)', () => {
    const { tasks, resolved } = deriveTaskCardState({
      isActive: false,
      frozenTasks: frozen,
      tasksState: rowState({ approved: true }),
      result: undefined,
    });
    expect(tasks).toBe(frozen);
    expect(resolved).toBeUndefined();
  });

  it('null tasksState → frozen snapshot, resolved from result only', () => {
    const { tasks, resolved } = deriveTaskCardState({
      isActive: true,
      frozenTasks: frozen,
      tasksState: null,
      result: { content: 'Task list approved by user.', isError: false },
    });
    expect(tasks).toBe(frozen);
    expect(resolved).toBe('approved');
  });

  it('archived/empty row → falls back to frozen even when flagged active', () => {
    const { tasks } = deriveTaskCardState({
      isActive: true,
      frozenTasks: frozen,
      tasksState: rowState({ tasks: [] }),
      result: undefined,
    });
    expect(tasks).toBe(frozen);
  });
});
