import type { StreamTask } from '../../../hooks/useAgentStream.js';
import type { PersistedTasksState } from '../types.js';

export interface TaskCardStateInput {
  /**
   * True only for the card backed by the session's CURRENT `coder_tasks_state`
   * row — i.e. the most recent `submit_tasks` tool_use block. The backend keeps
   * exactly one row per session (latest wins), so only this card may overlay the
   * live `tasksState`; superseded cards must render their own frozen snapshot.
   */
  isActive: boolean;
  /** The task list frozen in this tool_use's `input` at call time. */
  frozenTasks: StreamTask[];
  /** Session-global live task state from `/api/coder/sessions/:id/tasks`. */
  tasksState: PersistedTasksState | null | undefined;
  /** This tool_use's persisted tool_result, when already loaded. */
  result: { content: string; isError: boolean } | undefined;
}

export interface TaskCardState {
  tasks: StreamTask[];
  resolved: 'approved' | 'rejected' | undefined;
}

/**
 * Decide what a persisted `submit_tasks` card renders.
 *
 * - tasks: the active card overlays the live row (so it shows runtime status);
 *   every other card renders its own frozen snapshot — this stops a revised
 *   proposal from bleeding the latest list into older cards (and vice-versa).
 * - resolved: the tool_result is authoritative when present (approved/rejected);
 *   otherwise, for the active card, `tasksState.approved` hides the buttons the
 *   instant the user approves — before the tool_result message is loaded. A
 *   freshly-posted active list has `approved:false` (and no result) → undefined
 *   → buttons stay, which is correct.
 */
export function deriveTaskCardState({
  isActive,
  frozenTasks,
  tasksState,
  result,
}: TaskCardStateInput): TaskCardState {
  const tasks = isActive && tasksState?.tasks?.length ? tasksState.tasks : frozenTasks;
  const resultDerived: 'approved' | 'rejected' | undefined = result
    ? result.content.startsWith('Task list approved')
      ? 'approved'
      : 'rejected'
    : undefined;
  const resolved = resultDerived ?? (isActive && tasksState?.approved ? 'approved' : undefined);
  return { tasks, resolved };
}
