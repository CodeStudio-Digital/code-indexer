/**
 * Runners tab — the project's task player. Detects runnable commands
 * (npm/yarn/pnpm scripts, composer, gradle/maven, dotnet) and runs them
 * as long-lived PTYs that survive navigation. Left: detected commands +
 * active runs; right: live output of the selected run.
 *
 * Runs and their output live in the main process (shared PtyManager), so
 * leaving and returning to this tab re-attaches to the same processes.
 */

import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { RefreshCw } from 'lucide-react';
import type { DetectedRunners } from '@mcp/api-bus';
import { apiCall } from '../../../lib/api-client.js';
import { useRunningTasks, tasksForProject } from '../../../state/running-tasks.js';
import { DetectedList } from './runners/DetectedList.js';
import { ActiveList } from './runners/ActiveList.js';
import { RunnerOutput } from './runners/RunnerOutput.js';
import { NodeChip } from './runners/NodeChip.js';
import { RunnerShellChip } from './runners/RunnerShellChip.js';

interface RunnersTabProps {
  projectId: number;
}

export function RunnersTab({ projectId }: RunnersTabProps) {
  const { t } = useTranslation(['projects', 'common']);
  const [detected, setDetected] = useState<DetectedRunners | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const allTasks = useRunningTasks((s) => s.tasks);
  const tasks = tasksForProject(allTasks, projectId);

  const detect = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setDetected(await apiCall<DetectedRunners>('runner.detect', { projectId }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void detect();
  }, [detect]);

  // Keep a sensible selection: if nothing selected, follow the newest run.
  useEffect(() => {
    if (selectedId && tasks.some((task) => task.taskId === selectedId)) return;
    const newest = tasks[tasks.length - 1];
    setSelectedId(newest ? newest.taskId : null);
  }, [tasks, selectedId]);

  const selected = tasks.find((task) => task.taskId === selectedId) ?? null;

  return (
    <div className="h-full flex min-h-0">
      <div className="w-80 shrink-0 border-r flex flex-col min-h-0 overflow-auto">
        <div className="px-3 py-2 border-b space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold">{t('runners.title')}</span>
            <button
              type="button"
              onClick={() => void detect()}
              className="text-muted-foreground hover:text-foreground"
              aria-label={t('runners.rescan')}
              title={t('runners.rescan')}
            >
              <RefreshCw className="h-3.5 w-3.5" />
            </button>
          </div>
          <NodeChip projectId={projectId} />
          <RunnerShellChip projectId={projectId} />
        </div>
        <ActiveList tasks={tasks} selectedId={selectedId} onSelect={setSelectedId} />
        <DetectedList
          projectId={projectId}
          detected={detected}
          loading={loading}
          error={error}
          onStarted={setSelectedId}
        />
      </div>
      <div className="flex-1 min-w-0 relative bg-[#0b0d12]">
        {selected ? (
          <RunnerOutput key={selected.taskId} task={selected} />
        ) : (
          <div className="absolute inset-0 grid place-items-center text-xs text-muted-foreground">
            {t('runners.noSelection')}
          </div>
        )}
      </div>
    </div>
  );
}
