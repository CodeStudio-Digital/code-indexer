/**
 * Runners tab — the project's task player. Detects runnable commands
 * (npm/yarn/pnpm scripts, composer, gradle/maven, dotnet) and runs them
 * as long-lived PTYs that survive navigation. Left: detected commands +
 * active runs; right: live output of the selected run.
 *
 * Runtime/shell selection + management lives in the Project Settings modal
 * (the gear button in the header), not inline chips.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
  worktreePath?: string | null;
}

export function RunnersTab({ projectId, worktreePath }: RunnersTabProps) {
  const { t } = useTranslation(['projects', 'common']);
  const dark = useIsDark();
  const [detected, setDetected] = useState<DetectedRunners | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [project, setProject] = useState<Project | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const allTasks = useRunningTasks((s) => s.tasks);
  const tasks = useMemo(() => tasksForProject(allTasks, projectId, worktreePath), [allTasks, projectId, worktreePath]);

  useEffect(() => {
    let alive = true;
    void apiCall<Project>('projects.get', { id: projectId })
      .then((p) => { if (alive) setProject(p); })
      .catch(() => undefined);
    return () => { alive = false; };
  }, [projectId]);

  const detection = useRef<AbortController | null>(null);
  const detect = useCallback(async () => {
    detection.current?.abort();
    const controller = new AbortController();
    detection.current = controller;
    setLoading(true);
    setError(null);
    try {
      const result = await apiCall<DetectedRunners>('runner.detect', { projectId, worktreePath }, { signal: controller.signal });
      if (!controller.signal.aborted) setDetected(result);
    } catch (err) {
      if (!controller.signal.aborted) setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [projectId, worktreePath]);

  useEffect(() => {
    setDetected(null);
    void detect();
    return () => detection.current?.abort();
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
        <div className="px-3 py-2 border-b flex items-center gap-2">
          <span className="text-xs font-semibold shrink-0">{t('runners.title')}</span>
          {worktreePath && (
            <span className="min-w-0 truncate text-[11px] text-muted-foreground" title={worktreePath}>
              {worktreePath.split(/[\\/]/).filter(Boolean).at(-1)}
            </span>
          )}
          <div className="ml-auto flex shrink-0 items-center gap-2">
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
          worktreePath={worktreePath}
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
