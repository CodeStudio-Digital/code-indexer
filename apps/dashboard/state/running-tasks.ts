/**
 * Global registry mirror of the backend `runner.*` task list.
 *
 * The processes themselves live in the Electron main process (shared
 * PtyManager), so they survive renderer navigation. This store just
 * reflects their state: it opens the `runner.events` stream once and
 * replaces its `tasks` array on every backend snapshot. Both the global
 * header dropdown and the project Runners tab read from here.
 *
 * Actions (start/stop/restart) are thin wrappers over `apiCall` — the
 * resulting state change arrives back through the events stream, so we
 * never mutate `tasks` optimistically.
 */

import { create } from 'zustand';
import type { RunnerTask } from '@mcp/api-bus';
import { isDevServerCommand } from '@mcp/shared/utils/dev-server-url.js';
import { apiCall, apiStream, electronApi } from '../lib/api-client.js';

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

export async function startTask(input: {
  projectId: number;
  command: string;
  label: string;
  manager: RunnerTask['manager'];
}): Promise<RunnerTask> {
  return apiCall<RunnerTask>('runner.start', input);
}

export async function stopTask(taskId: string): Promise<void> {
  await apiCall('runner.stop', { taskId });
}

export async function dismissTask(taskId: string): Promise<void> {
  await apiCall('runner.dismiss', { taskId });
}

export async function restartTask(taskId: string): Promise<RunnerTask> {
  return apiCall<RunnerTask>('runner.restart', { taskId });
}
