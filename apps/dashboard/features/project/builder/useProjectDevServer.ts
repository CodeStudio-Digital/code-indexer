/**
 * Drives the dev-server preview for a project via the existing Runner infra
 * (host PTY). Resolves the preview URL three ways, in priority order:
 *   1. manual override (user typed a URL) — persisted per project;
 *   2. a port PINNED by the builder scaffold (`opts.pinnedPort`);
 *   3. auto-detected from the dev runner's terminal output (first
 *      `http://localhost:PORT` / `0.0.0.0:PORT` line it prints).
 * Also exposes start/restart/stop (the "microservice" controls).
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { RunnerTask } from '@mcp/api-bus';
import { apiStream } from '../../../lib/api-client.js';
import {
  useRunningTasks,
  tasksForProject,
  isDevServerTask,
  initRunningTasks,
  startTask,
  stopTask,
  restartTask,
} from '../../../state/running-tasks.js';

export type DevServerStatus = 'stopped' | 'running' | 'exited';

const URL_RE = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0):(\d+)/i;

function manualKey(projectId: number): string {
  return `mcp.preview.url.${projectId}`;
}

export function useProjectDevServer(projectId: number, opts: { pinnedPort?: number } = {}) {
  const tasks = useRunningTasks((s) => s.tasks);
  const [detectedUrl, setDetectedUrl] = useState<string | null>(null);
  const [manualUrl, setManualUrlState] = useState<string>(() => {
    try {
      return localStorage.getItem(manualKey(projectId)) ?? '';
    } catch {
      return '';
    }
  });

  useEffect(() => {
    initRunningTasks();
  }, []);

  const devTask: RunnerTask | undefined = useMemo(() => {
    const mine = tasksForProject(tasks, projectId);
    // Prefer a running dev server; fall back to any dev-ish task.
    return mine.find((t) => t.status === 'running' && isDevServerTask(t)) ?? mine.find(isDevServerTask);
  }, [tasks, projectId]);

  // Auto-detect the URL from the dev task's terminal output (when not
  // pinned and no manual override). Resets when the task changes.
  const terminalId = devTask?.terminalId;
  useEffect(() => {
    if (opts.pinnedPort || manualUrl || !terminalId) return;
    let cancelled = false;
    (async () => {
      try {
        for await (const chunk of apiStream<{ type: string; data?: string }>('terminal.output', { terminalId })) {
          if (cancelled) return;
          if (chunk.type !== 'data' || !chunk.data) continue;
          const m = URL_RE.exec(chunk.data);
          if (m) {
            setDetectedUrl(`http://localhost:${m[1]}`);
            return; // first hit wins
          }
        }
      } catch {
        /* stream ended / unavailable — manual URL remains the fallback */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [terminalId, opts.pinnedPort, manualUrl]);

  const setManualUrl = useCallback(
    (url: string) => {
      setManualUrlState(url);
      try {
        if (url) localStorage.setItem(manualKey(projectId), url);
        else localStorage.removeItem(manualKey(projectId));
      } catch {
        /* ignore */
      }
    },
    [projectId],
  );

  const url =
    manualUrl ||
    (opts.pinnedPort ? `http://localhost:${opts.pinnedPort}` : null) ||
    detectedUrl;

  const status: DevServerStatus =
    devTask?.status === 'running' ? 'running' : devTask ? 'exited' : 'stopped';

  const start = useCallback(async () => {
    if (devTask?.status === 'running') return;
    if (devTask) return void restartTask(devTask.taskId);
    await startTask({ projectId, command: 'npm run dev', label: 'dev', manager: 'npm' });
  }, [devTask, projectId]);

  const restart = useCallback(async () => {
    if (devTask) await restartTask(devTask.taskId);
    else await startTask({ projectId, command: 'npm run dev', label: 'dev', manager: 'npm' });
  }, [devTask, projectId]);

  const stop = useCallback(async () => {
    if (devTask) await stopTask(devTask.taskId);
  }, [devTask]);

  return { status, url, devTask, start, restart, stop, manualUrl, setManualUrl };
}
