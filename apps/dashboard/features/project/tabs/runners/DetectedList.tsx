/**
 * Detected runnable commands, grouped by package manager. Each group can
 * surface an "install dependencies" banner (when node_modules/vendor is
 * missing) and a Run button per command. Starting a command spawns a
 * tracked run via the global store and selects it.
 */

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Play, Download, AlertCircle } from 'lucide-react';
import type { DetectedGroup, DetectedRunners, RunnerManager } from '@mcp/api-bus';
import { startTask } from '../../../../state/running-tasks.js';

interface DetectedListProps {
  projectId: number;
  detected: DetectedRunners | null;
  loading: boolean;
  error: string | null;
  onStarted: (taskId: string) => void;
}

export function DetectedList({ projectId, detected, loading, error, onStarted }: DetectedListProps) {
  const { t } = useTranslation(['projects', 'common']);
  const [busy, setBusy] = useState<string | null>(null);

  async function run(label: string, command: string, manager: RunnerManager, key: string, cwd?: string) {
    setBusy(key);
    try {
      const task = await startTask({ projectId, command, label, manager, cwd });
      onStarted(task.taskId);
    } finally {
      setBusy(null);
    }
  }

  if (loading) {
    return <div className="px-3 py-2 text-xs text-muted-foreground">{t('common:actions.loading')}</div>;
  }
  if (error) {
    return (
      <div className="px-3 py-2 text-xs text-red-400 flex items-center gap-1.5">
        <AlertCircle className="h-3.5 w-3.5" /> {error}
      </div>
    );
  }
  if (!detected || detected.groups.length === 0) {
    return <div className="px-3 py-2 text-xs text-muted-foreground">{t('runners.noneDetected')}</div>;
  }

  return (
    <div className="flex-1">
      {detected.groups.map((group) => (
        <Group
          key={`${group.manager}:${group.source}`}
          group={group}
          busy={busy}
          onRun={run}
        />
      ))}
    </div>
  );
}

function Group({
  group,
  busy,
  onRun,
}: {
  group: DetectedGroup;
  busy: string | null;
  onRun: (label: string, command: string, manager: RunnerManager, key: string, cwd?: string) => void;
}) {
  const { t } = useTranslation(['projects']);
  return (
    <div className="border-b">
      <div className="px-3 py-1.5 flex items-center justify-between bg-muted/30">
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
          {group.manager} · {group.source}
        </span>
      </div>
      {group.installNeeded && group.installCommand && (
        <button
          type="button"
          disabled={busy !== null}
          onClick={() => onRun(t('runners.install'), group.installCommand!, group.manager, `install:${group.manager}:${group.source}`, group.cwd)}
          className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-amber-400 hover:bg-amber-500/10 disabled:opacity-50"
        >
          <Download className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">{t('runners.installHint', { cmd: group.installCommand })}</span>
        </button>
      )}
      {group.runners.length === 0 ? (
        <div className="px-3 py-1.5 text-[11px] text-muted-foreground">{t('runners.noScripts')}</div>
      ) : (
        group.runners.map((r) => {
          const key = r.id;
          return (
            <button
              key={key}
              type="button"
              disabled={busy !== null}
              onClick={() => onRun(r.label, r.command, r.manager, key, group.cwd)}
              className="w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-muted/60 disabled:opacity-50 group"
            >
              <Play className="h-3.5 w-3.5 shrink-0 text-emerald-400" />
              <span className="flex-1 min-w-0">
                <span className="block text-xs font-medium truncate">{r.label}</span>
                <span className="block text-[10px] text-muted-foreground truncate">{r.command}</span>
              </span>
            </button>
          );
        })
      )}
    </div>
  );
}
