import React from 'react';
import { ExternalLink, MousePointerClick, RotateCw, Terminal, Zap } from 'lucide-react';
import { StatusDot } from './StatusDot.js';

interface Props {
  status: string | null;
  previewUrl: string;
  restartingDev: boolean;
  canOpenLogs: boolean;
  onRestartDev: () => void;
  onOpenLogs: () => void;
  onReload: () => void;
  serviceSwitcher?: React.ReactNode;
  /** Builder studio element-selection toggle (optional). */
  selectMode?: boolean;
  onToggleSelectMode?: () => void;
  /** Extra controls (device frames, problems badge) at the toolbar's right. */
  rightSlot?: React.ReactNode;
}

export function PreviewToolbar({
  status,
  previewUrl,
  restartingDev,
  canOpenLogs,
  onRestartDev,
  onOpenLogs,
  onReload,
  serviceSwitcher,
  selectMode,
  onToggleSelectMode,
  rightSlot,
}: Props) {
  return (
    <div className="h-10 flex items-center gap-2 px-3 border-b">
      <div className="flex-1 flex items-center gap-2 text-xs min-w-0">
        <StatusDot status={status} />
        {serviceSwitcher}
        <span className="font-mono truncate text-muted-foreground" title={previewUrl || '—'}>
          {previewUrl || '—'}
        </span>
      </div>
      {onToggleSelectMode && (
        <button
          onClick={onToggleSelectMode}
          disabled={status !== 'ready'}
          className={`p-1.5 rounded-md disabled:opacity-40 ${
            selectMode
              ? 'bg-indigo-100 text-indigo-600 dark:bg-indigo-900/40'
              : 'hover:bg-muted'
          }`}
          title={selectMode ? 'Selecting elements — click one in the preview (Esc to cancel)' : 'Select an element to edit'}
          aria-pressed={!!selectMode}
        >
          <MousePointerClick className="h-3.5 w-3.5" />
        </button>
      )}
      {rightSlot}
      <button
        onClick={onRestartDev}
        disabled={restartingDev || status === 'paused'}
        className="p-1.5 rounded-md hover:bg-muted disabled:opacity-40"
        title="Restart dev-server (keeps files, relaunches Vite + resets vite.config.ts)"
      >
        <Zap className={`h-3.5 w-3.5 ${restartingDev ? 'animate-pulse' : ''}`} />
      </button>
      <button
        onClick={onOpenLogs}
        disabled={!canOpenLogs}
        className="p-1.5 rounded-md hover:bg-muted disabled:opacity-40"
        title="View dev-server logs"
      >
        <Terminal className="h-3.5 w-3.5" />
      </button>
      <button
        onClick={onReload}
        disabled={status !== 'ready'}
        className="p-1.5 rounded-md hover:bg-muted disabled:opacity-40"
        title="Reload preview"
      >
        <RotateCw className="h-3.5 w-3.5" />
      </button>
      <a
        href={previewUrl || '#'}
        target="_blank"
        rel="noreferrer"
        aria-disabled={status !== 'ready'}
        className={
          'p-1.5 rounded-md hover:bg-muted ' +
          (status !== 'ready' ? 'opacity-40 pointer-events-none' : '')
        }
        title="Open in new tab"
      >
        <ExternalLink className="h-3.5 w-3.5" />
      </a>
    </div>
  );
}
