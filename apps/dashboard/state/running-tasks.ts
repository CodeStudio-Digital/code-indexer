/**
 * Global registry mirror of the backend `runner.*` task list.
 *
 * The processes themselves live in the Electron main process (shared
 * PtyManager), so they survive renderer navigation. This store just
 * reflects their state: it opens the `runner.events` stream once and
 * replaces its `tasks` array on every backend snapshot. Both the global
 * header dropdown and the project Runners tab read from here.
 *
 * Confirmed RPC results update the mirror immediately; the events stream
 * supplies process exits and changes from other windows.
 */

import { create } from 'zustand';
import type { RunnerTask, RuntimeTarget } from '@mcp/api-bus';
import { isDevServerCommand } from '@mcp/shared/utils/dev-server-url.js';
import { apiCall, apiStream, electronApi } from '../lib/api-client.js';
import { recordExecutionFailure } from './execution-output.js';

interface RunningTasksState {
  tasks: RunnerTask[];
  /** Whether the events stream has been opened (idempotent guard). */
  started: boolean;
  setTasks: (tasks: RunnerTask[]) => void;
}

export const useRunningTasks = create<RunningTasksState>((set) => ({
  tasks: [],
  started: false,
  setTasks: (tasks) => set({ tasks }),
}));

/** Tasks for a single project (any status). */
export function tasksForProject(tasks: RunnerTask[], projectId: number): RunnerTask[] {
  return tasks.filter((t) => t.projectId === projectId);
}

/**
 * Heuristic: does this runner task look like a long-running dev/preview
 * server (so the project view should surface a live preview)? Delegates to
 * the shared `isDevServerCommand` so the dashboard and the agent's backend
 * preview resolver agree on what counts as a dev server.
 */
export function isDevServerTask(task: RunnerTask): boolean {
  return isDevServerCommand(task.command, task.label ?? undefined);
}

/** Count of currently-running tasks (across all projects). */
export function runningCount(tasks: RunnerTask[]): number {
  return tasks.filter((t) => t.status === 'running').length;
}

/**
 * Open the events stream once (call from AppShell mount). No-op outside
 * Electron or if already started. Auto-restarts the loop if the stream
 * ends (e.g. main-process reload during dev).
 */
export function initRunningTasks(): void {
  if (useRunningTasks.getState().started) return;
  if (!electronApi()) return;
  useRunningTasks.setState({ started: true });
  void (async () => {
    for (;;) {
      try {
        const stream = apiStream<RunnerTask[]>('runner.events', {});
        for await (const snapshot of stream) {
          useRunningTasks.getState().setTasks(snapshot);
        }
      } catch {
        /* stream dropped — back off and reopen */
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
  })();
}

/** Publish a confirmed launch even when the event stream is reconnecting. */
function rememberTask(task: RunnerTask, replacedId?: string): RunnerTask {
  useRunningTasks.setState((state) => {
    const tasks = state.tasks.filter((item) => item.taskId !== replacedId);
    // An exit event can beat the start reply. Preserve that newer status.
    return { tasks: tasks.some((item) => item.taskId === task.taskId) ? tasks : [...tasks, task] };
  });
  return task;
}

export async function startTask(input: {
  projectId: number;
  command: string;
  label: string;
  manager: RunnerTask['manager'];
  /** Project-relative working dir (defaults to project root); for nested manifests. */
  cwd?: string;
  target?: RuntimeTarget;
}): Promise<RunnerTask> {
  try {
    return rememberTask(await apiCall<RunnerTask>('runner.start', input));
  } catch (error) {
    recordExecutionFailure({
      projectId: input.projectId,
      source: 'runner',
      label: input.label,
      command: input.command,
      error,
    });
    throw error;
  }
}

/** Run a markdown fenced code block (materialised + run by the backend). */
export async function startSnippet(input: {
  projectId: number;
  language: string;
  code: string;
  label: string;
}): Promise<RunnerTask> {
  try {
    return rememberTask(await apiCall<RunnerTask>('runner.runSnippet', input));
  } catch (error) {
    recordExecutionFailure({
      projectId: input.projectId,
      source: 'runner',
      label: input.label,
      command: `${input.language} snippet`,
      error,
    });
    throw error;
  }
}

export async function stopTask(taskId: string): Promise<void> {
  await apiCall('runner.stop', { taskId });
  useRunningTasks.setState((state) => ({
    tasks: state.tasks.map((task) => task.taskId === taskId ? { ...task, status: 'stopped' } : task),
  }));
}

export async function dismissTask(taskId: string): Promise<void> {
  await apiCall('runner.dismiss', { taskId });
  useRunningTasks.setState((state) => ({ tasks: state.tasks.filter((task) => task.taskId !== taskId) }));
}

export async function restartTask(taskId: string): Promise<RunnerTask> {
  return rememberTask(await apiCall<RunnerTask>('runner.restart', { taskId }), taskId);
}
