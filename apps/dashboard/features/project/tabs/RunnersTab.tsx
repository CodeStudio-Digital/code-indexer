/**
 * Runners tab — the project's task player. Detects runnable commands
 * (npm/yarn/pnpm scripts, composer, gradle/maven, dotnet) and runs them
 * as long-lived PTYs that survive navigation. Left: detected commands +
 * active runs; right: live output of the selected run.
 *
 * Runtime/shell selection + management lives in the Project Settings modal
 * (the gear button in the header), not inline chips.
 */

import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { RefreshCw, Settings2 } from 'lucide-react';
import type { DetectedRunners } from '@mcp/api-bus';
import type { Project } from '@mcp/shared/types.js';
import { apiCall } from '../../../lib/api-client.js';
import { useRunningTasks, tasksForProject } from '../../../state/running-tasks.js';
import { DetectedList } from './runners/DetectedList.js';
import { ActiveList } from './runners/ActiveList.js';
import { RunnerOutput } from './runners/RunnerOutput.js';
import { ProjectSettingsModal } from '../settings/ProjectSettingsModal.js';
import { TERMINAL_SURFACE_BG } from '../../shared/terminal/SingleTerminal.js';
import { useIsDark } from '../../builder/preview/files/viewer/useIsDark.js';

interface RunnersTabProps {
  projectId: number;
}

export function RunnersTab({ projectId }: RunnersTabProps) {
  const { t } = useTranslation(['projects', 'common']);
  const dark = useIsDark();
  const [detected, setDetected] = useState<DetectedRunners | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [project, setProject] = useState<Project | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const allTasks = useRunningTasks((s) => s.tasks);
  const tasks = tasksForProject(allTasks, projectId);

  useEffect(() => {
    let alive = true;
    void apiCall<Project>('projects.get', { id: projectId })
      .then((p) => { if (alive) setProject(p); })
      .catch(() => undefined);
    return () => { alive = false; };
  }, [projectId]);

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
        <div className="px-3 py-2 border-b flex items-center justify-between">
          <span className="text-xs font-semibold">{t('runners.title')}</span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void detect()}
              className="text-muted-foreground hover:text-foreground"
              aria-label={t('runners.rescan')}
              title={t('runners.rescan')}
            >
              <RefreshCw className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={() => setSettingsOpen(true)}
              disabled={!project}
              className="text-muted-foreground hover:text-foreground disabled:opacity-40"
              aria-label={t('settings.open')}
              title={t('settings.open')}
            >
              <Settings2 className="h-3.5 w-3.5" />
            </button>
          </div>
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
      <div
        className="flex-1 min-w-0 relative"
        style={{ background: dark ? TERMINAL_SURFACE_BG.dark : TERMINAL_SURFACE_BG.light }}
      >
        {selected ? (
          <RunnerOutput key={selected.taskId} task={selected} />
        ) : (
          <div className="absolute inset-0 grid place-items-center text-xs text-muted-foreground">
            {t('runners.noSelection')}
          </div>
        )}
      </div>
      {project && (
        <ProjectSettingsModal
          project={project}
          open={settingsOpen}
          onOpenChange={setSettingsOpen}
          initialSection="node"
          onSaved={() => void apiCall<Project>('projects.get', { id: projectId }).then(setProject).catch(() => undefined)}
        />
      )}
    </div>
  );
}
