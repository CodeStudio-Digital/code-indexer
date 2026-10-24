/**
 * Shared model for the unified `task_list` tool — the merge of the old
 * `todo_write`/`update_todo` (lightweight checklist) and
 * `submit_tasks`/`execute_tasks` (gated orchestration) systems into ONE store
 * keyed by `TasksState.gate`.
 *
 * This module is a leaf: it depends only on `sessions/types` so it can be
 * imported by the tools layer (`tasks.ts`, `todo.ts`) AND the core layer
 * (`runner.ts`, `active-context.ts`) without an import cycle. `TodoItem` and
 * `generateTodoId` live here (re-exported by `todo.ts` for back-compat) so the
 * track-gate ⇄ checklist mapping has a single home.
 */
import { randomUUID } from 'node:crypto';
import type { CoderTask, TaskGate, TaskStatus, TasksState } from '@mcp/session-storage/session-state-types.js';

/** Recognize legacy persisted uncertainty as well as the explicit outcome field. */
export function taskNeedsReconciliation(task: Pick<CoderTask, 'result'>): boolean {
  return task.result?.effectOutcome === 'unknown' || /outcome[_ ]unknown/i.test(task.result?.errors ?? '');
}

/**
 * A single lightweight checklist item — the track-gate view of a `CoderTask`.
 * Identical to the old `todo_write` item shape so the UI/active-context render
 * unchanged.
 */
export interface TodoItem {
  /** Stable identifier — referenced by `update_todo`/`task_list` patches. */
  id: string;
  /** Imperative form — what the agent is going to do ("Run tests"). */
  content: string;
  /** Present continuous — what shows in the UI while it runs ("Running tests"). */
  activeForm: string;
  status: 'pending' | 'in_progress' | 'completed';
}

/** 8 hex chars from a UUID v4 — short enough to echo, collision-safe at ≤50 items. */
export function generateTodoId(): string {
  return randomUUID().replace(/-/g, '').slice(0, 8);
}

/** Legacy rows had no `gate`; their only prior meaning was the approve flow. */
export function effectiveGate(state: TasksState | null | undefined): TaskGate {
  return state?.gate ?? 'approve';
}

export function isTrackState(state: TasksState | null | undefined): boolean {
  return !!state && state.tasks.length > 0 && effectiveGate(state) === 'track';
}

export function isApproveState(state: TasksState | null | undefined): boolean {
  return !!state && state.tasks.length > 0 && effectiveGate(state) === 'approve';
}

// ─── status mapping (checklist ⇄ task) ─────────────────────────────────

export function todoStatusToTaskStatus(s: TodoItem['status']): TaskStatus {
  return s === 'in_progress' ? 'running' : s === 'completed' ? 'done' : 'pending';
}

export function taskStatusToTodoStatus(s: TaskStatus): TodoItem['status'] {
  return s === 'running' ? 'in_progress' : s === 'done' ? 'completed' : 'pending';
}

// ─── item mapping (checklist ⇄ task) ───────────────────────────────────

export function todoToTrackTask(todo: TodoItem): CoderTask {
  return {
    id: todo.id,
    title: todo.content,
    description: '',
    content: todo.content,
    activeForm: todo.activeForm,
    files: [],
    references: [],
    depends_on: [],
    suggested_mode: 'inline',
    estimated_complexity: 'small',
    kind: 'implement',
    status: todoStatusToTaskStatus(todo.status),
  };
}

export function trackTaskToTodo(task: CoderTask): TodoItem {
  const content = task.content ?? task.title;
  return {
    id: task.id,
    content,
    activeForm: task.activeForm ?? content,
    status: taskStatusToTodoStatus(task.status),
  };
}

/** The checklist view of a unified state — empty unless it is a track list. */
export function deriveTodosFromState(state: TasksState | null | undefined): TodoItem[] {
  if (!isTrackState(state)) return [];
  return state!.tasks.map(trackTaskToTodo);
}

/** Build a fresh track-gate `TasksState` from a checklist. Never pauses; pre-approved. */
export function buildTrackState(todos: TodoItem[], summary = ''): TasksState {
  return {
    gate: 'track',
    summary,
    tasks: todos.map(todoToTrackTask),
    execution_mode: null,
    approved: true,
    current_task_id: null,
  };
}
