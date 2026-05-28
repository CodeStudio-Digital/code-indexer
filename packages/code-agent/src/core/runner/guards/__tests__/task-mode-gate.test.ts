/**
 * Unit tests for `checkTaskModeGate`.
 *
 * Contract:
 *   - No tasks state → allow.
 *   - Tasks not approved → allow.
 *   - `execution_mode` != 'all-subagent' → allow (inline/smart/per-task
 *     are the model's discretion).
 *   - Workflow-internal tools (execute_tasks, task_complete, …) → always allow.
 *   - Read-only tools (`mutates=false`) → allow.
 *   - All tasks done/skipped → workflow finished, allow.
 *   - Mutating non-workflow tool while pending → REFUSE with pointer to
 *     `execute_tasks` and the next pending task id.
 */
import { describe, it, expect } from 'vitest';
import { checkTaskModeGate, type TaskGateState } from '../task-mode-gate.js';

function state(overrides: Partial<TaskGateState> = {}): TaskGateState {
  return {
    approved: true,
    execution_mode: 'all-subagent',
    tasks: [
      { id: 'tsk_one', status: 'pending' },
      { id: 'tsk_two', status: 'pending' },
    ],
    ...overrides,
  };
}

describe('checkTaskModeGate', () => {
  it('allows when there is no tasks state', () => {
    expect(checkTaskModeGate({
      tasksState: null,
      toolName: 'edit_file',
      toolMutates: true,
    })).toBeNull();
  });

  it('allows when the tasks list has not been approved yet', () => {
    expect(checkTaskModeGate({
      tasksState: state({ approved: false }),
      toolName: 'edit_file',
      toolMutates: true,
    })).toBeNull();
  });

  it('allows for inline mode regardless of mutation', () => {
    expect(checkTaskModeGate({
      tasksState: state({ execution_mode: 'inline' }),
      toolName: 'edit_file',
      toolMutates: true,
    })).toBeNull();
  });

  it('allows for smart and per-task modes (model discretion)', () => {
    for (const mode of ['smart', 'per-task'] as const) {
      expect(checkTaskModeGate({
        tasksState: state({ execution_mode: mode }),
        toolName: 'write_file',
        toolMutates: true,
      })).toBeNull();
    }
  });

  it('allows workflow tools even under all-subagent', () => {
    // Frente D — `execute_task` (singular) is no longer registered, so
    // the gate doesn't need to allowlist it. `execute_tasks` (plural) is
    // the only dispatch entry point now.
    for (const name of [
      'execute_tasks',
      'task_complete',
      'list_tasks',
      'cancel_tasks',
      'delete_tasks',
      'archive_task_list',
      'update_task',
      'submit_tasks',
      'spawn_agent',
    ]) {
      expect(checkTaskModeGate({
        tasksState: state(),
        toolName: name,
        toolMutates: true,
      })).toBeNull();
    }
  });

  it('allows read-only tools under all-subagent', () => {
    expect(checkTaskModeGate({
      tasksState: state(),
      toolName: 'read_file',
      toolMutates: false,
    })).toBeNull();
  });

  it('allows mutating tools once every task is terminal', () => {
    expect(checkTaskModeGate({
      tasksState: state({
        tasks: [
          { id: 'tsk_one', status: 'done' },
          { id: 'tsk_two', status: 'skipped' },
        ],
      }),
      toolName: 'edit_file',
      toolMutates: true,
    })).toBeNull();
  });

  it('REFUSES mutating non-workflow tools while tasks are pending', () => {
    const refusal = checkTaskModeGate({
      tasksState: state(),
      toolName: 'edit_file',
      toolMutates: true,
    });
    expect(refusal).not.toBeNull();
    expect(refusal!).toMatch(/all-subagent/);
    // Frente D — refusal now points at `execute_tasks` (plural).
    expect(refusal!).toMatch(/execute_tasks/);
    expect(refusal!).toMatch(/tsk_one/); // next pending task id surfaced
  });

  it('points at the FIRST non-terminal task as the next id', () => {
    const refusal = checkTaskModeGate({
      tasksState: state({
        tasks: [
          { id: 'tsk_one', status: 'done' },
          { id: 'tsk_two', status: 'pending' },
          { id: 'tsk_three', status: 'pending' },
        ],
      }),
      toolName: 'run_command',
      toolMutates: true,
    });
    expect(refusal).not.toBeNull();
    // Frente D — refusal text now mentions `(next pending: ID)` instead
    // of an embedded `task_id` JSON literal.
    expect(refusal!).toMatch(/next pending: tsk_two/);
    expect(refusal!).toMatch(/Pending tasks: tsk_two, tsk_three/);
  });
});
