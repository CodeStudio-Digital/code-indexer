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
