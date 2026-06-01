/**
 * Handlers for the `runner` namespace — the task player.
 *
 * Detects runnable commands (see ./detect.ts) and runs them as PTYs in
 * the shared manager, so a run survives renderer navigation and its
 * colored output streams through `terminal.output`. The registry here
 * only tracks metadata + status; the PTY lifecycle lives in PtyManager.
 *
 * No "pause" — OS suspend isn't portable. Controls are stop + restart.
 */

import { randomUUID } from 'node:crypto';
import { ensureDataDir } from '@mcp/shared/utils/config.js';
import { ApiError, type RunnerApi, type RunnerTask } from '@mcp/api-bus';
import type { HandlerDeps } from '../types.js';
import { sharedPtyManager } from '../terminal/pty-manager.js';
import { resolveProjectNodeBinDir } from '../runtime/node-manager.js';
import { detectRunners } from './detect.js';

export function createRunnerHandlers(deps: HandlerDeps): RunnerApi {
  const { db } = deps;
  const manager = sharedPtyManager;
  const tasks = new Map<string, RunnerTask>();
  const bus = new TaskBus();

  function snapshot(): RunnerTask[] {
    return [...tasks.values()].map((t) => ({ ...t }));
  }

  function emit(): void {
    bus.push(snapshot());
  }

  function project(projectId: number): { root_path: string; name: string } {
    const p = db.getProject(projectId);
    if (!p) throw new ApiError('not_found', 404, 'project not found');
    return p;
  }

  function launch(input: {
    projectId: number;
    command: string;
    label: string;
    manager: RunnerTask['manager'];
  }): RunnerTask {
    const p = project(input.projectId);
    const nodeBinDir = resolveProjectNodeBinDir(db, input.projectId, ensureDataDir()) ?? undefined;
    const { id: terminalId } = manager.spawn({
      command: input.command,
      cwd: p.root_path,
      cols: 80,
      rows: 24,
      nodeBinDir,
    });
    const task: RunnerTask = {
      taskId: randomUUID(),
      terminalId,
      projectId: input.projectId,
      projectName: p.name,
      label: input.label,
      command: input.command,
      manager: input.manager,
      status: 'running',
      exitCode: null,
      startedAt: Date.now(),
    };
    tasks.set(task.taskId, task);
    // Flip status when the PTY exits — unless we already marked it
    // 'stopped' via an explicit kill (don't clobber that).
    manager.onExit(terminalId, (code) => {
      const current = tasks.get(task.taskId);
      if (!current || current.status === 'stopped') return;
      current.status = 'exited';
      current.exitCode = code;
      emit();
    });
    emit();
    return { ...task };
  }

  return {
    async detect({ projectId }) {
      return detectRunners(project(projectId).root_path);
    },

    async start(input) {
      return launch(input);
    },

    async stop({ taskId }) {
      const task = tasks.get(taskId);
      if (!task) throw new ApiError('not_found', 404, 'task not found');
      task.status = 'stopped';
      try {
        manager.get(task.terminalId).pty.kill();
      } catch {
        /* PTY may have already exited — status still reflects intent */
      }
      emit();
    },

    async dismiss({ taskId }) {
      const task = tasks.get(taskId);
      if (!task) return;
      // If somehow still running, terminate the PTY before dropping it so
      // we don't orphan the process.
      if (task.status === 'running') {
        try {
          manager.get(task.terminalId).pty.kill();
        } catch {
          /* already gone */
        }
      }
      tasks.delete(taskId);
      emit();
    },

    async restart({ taskId }) {
      const task = tasks.get(taskId);
      if (!task) throw new ApiError('not_found', 404, 'task not found');
      try {
        manager.get(task.terminalId).pty.kill();
      } catch {
        /* already gone */
      }
      tasks.delete(taskId);
      const next = launch({
        projectId: task.projectId,
        command: task.command,
        label: task.label,
        manager: task.manager,
      });
      return next;
    },

    async list() {
      return snapshot();
    },

    events() {
      return bus.iterable(snapshot());
    },
  };
}

/**
 * Broadcaster for task-list snapshots. Each `events()` consumer gets its
 * own queue + waiter so a slow reader doesn't block the others. Mirrors
 * the backpressure shape of the terminal output iterable.
 */
class TaskBus {
  private readonly subscribers = new Set<(snap: RunnerTask[]) => void>();

  push(snap: RunnerTask[]): void {
    for (const s of this.subscribers) s(snap);
  }

  iterable(initial: RunnerTask[]): AsyncIterable<RunnerTask[]> {
    const subscribers = this.subscribers;
    return {
      [Symbol.asyncIterator](): AsyncIterator<RunnerTask[]> {
        const queue: RunnerTask[][] = [initial];
        const waiters: Array<(r: IteratorResult<RunnerTask[]>) => void> = [];
        const onSnap = (snap: RunnerTask[]) => {
          const w = waiters.shift();
          if (w) w({ value: snap, done: false });
          else queue.push(snap);
        };
        subscribers.add(onSnap);
        return {
          async next(): Promise<IteratorResult<RunnerTask[]>> {
            if (queue.length > 0) return { value: queue.shift()!, done: false };
            return new Promise((resolve) => waiters.push(resolve));
          },
          async return(): Promise<IteratorResult<RunnerTask[]>> {
            subscribers.delete(onSnap);
            return { value: undefined as never, done: true };
          },
        };
      },
    };
  }
}
