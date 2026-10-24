import type { CoderTask } from '@mcp/session-storage/session-state-types.js';
import type { ToolContext } from '../core/tool.js';
import type { TodoItem } from '../tools/task-list-shared.js';

export type TaskRuntimeEvent = 'task_updated' | 'task_finished' | 'task_started'
  | 'task_run_started' | 'task_run_finished' | 'task_run_task_started'
  | 'task_run_task_progress' | 'task_run_task_finished'
  | 'agents_group_start' | 'agent_progress' | 'agents_group_end';

/** Per-invocation task state. Native implementations stage a single journal
 * result; the legacy implementation continues to use its existing runner. */
export interface TaskToolRuntime {
  readonly currentTodos: TodoItem[];
  setTodos(todos: TodoItem[]): void | Promise<void>;
  currentTaskScopeId(): string | null;
  currentTaskScopeFiles(): string[] | null;
  endTaskScope(): void;
  beginTaskScope?(scope: { id: string; files: string[] }): void;
  markTasksApproved(): void;
  emit(event: TaskRuntimeEvent, payload: unknown): void;
  requestBudget?(payload: { runId: string; spent: number; cap: number; estimated: number;
    options: ReadonlyArray<string>; timeoutMs: number }): Promise<string>;
  requestTasks(payload: { tool_use_id: string; summary: string; tasks: CoderTask[]; version: number }): Promise<string>;
}

export interface TaskToolPort {
  bind(context: ToolContext, toolName: string): ToolContext;
}

/** task_list delegates to aliases without losing the original invocation id. */
export function bindTaskContext(context: ToolContext, toolName: string): ToolContext {
  return context.taskRuntime ? context : context.ports?.tasks?.bind(context, toolName) ?? context;
}
