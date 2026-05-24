/**
 * Status bar at the very bottom of the Workspace — IDE convention.
 *
 * Surface: project · git branch · active file · unsaved count ·
 * indexed/total file + symbol totals · language label (with LSP
 * support indicator). The LSP indicator pulls double duty as a hint:
 * green for TS/JS (full IntelliSense), amber for everything else
 * (syntax highlight only).
 */

import { Activity, Circle, GitBranch, Languages } from 'lucide-react';
import { useApi } from '../../../hooks/useApi.js';
import { useWorkspaceStore } from '../../../state/workspace.js';
import { inferLanguage } from '../../../lib/language-detect.js';
import { Tooltip, TooltipContent, TooltipTrigger } from '../../../components/ui/tooltip.js';
import { cn } from '../../../lib/utils.js';
import { fileIconFor } from '../../../lib/file-icon.js';

interface StatusBarProps {
  projectId: number;
  projectName: string;
}

interface GitStatusSummary {
  branch?: string | null;
  ahead?: number;
  behind?: number;
  modified?: number;
  staged?: number;
  untracked?: number;
}

export function StatusBar({ projectId, projectName }: StatusBarProps) {
  const activeFilePath = useWorkspaceStore((s) => s.activeFilePath);
  const dirtyCount = useWorkspaceStore(
    (s) => s.openFiles.filter((f) => f.kind !== 'diff' && f.dirty).length,
  );
  const { data: stats } = useApi<{ file_count: number; symbol_count: number; total_lines: number }>(
    `/projects/${projectId}/stats`,
  );
  // projectGit.status returns the branch + ahead/behind/dirty counters
  // so we can echo what JetBrains shows in the bottom-right corner.
  // Polled implicitly when projectId changes; manual refresh isn't
  // critical for a passive status indicator.
  const { data: git } = useApi<GitStatusSummary>(`/projects/${projectId}/git/status`);

  const lang = inferLanguage(activeFilePath);
  const { Icon: TypeIcon, colorClass: typeColor } = fileIconFor(activeFilePath ?? '');
  const gitDirty = (git?.modified ?? 0) + (git?.staged ?? 0) + (git?.untracked ?? 0);

  return (
    <footer className="h-5 shrink-0 border-t bg-card/60 flex items-center px-2 gap-3 text-[10px] text-muted-foreground select-none">
      <span className="inline-flex items-center gap-1 truncate">
        <Circle className="h-1.5 w-1.5 fill-green-500 text-green-500" />
        <span className="truncate max-w-[160px]">{projectName}</span>
      </span>
      {git?.branch && (
        <>
          <span className="opacity-40">·</span>
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="inline-flex items-center gap-1 truncate max-w-[220px] cursor-default">
                <GitBranch className={cn('h-2.5 w-2.5', gitDirty > 0 ? 'text-amber-400' : 'text-muted-foreground')} />
                <span className="truncate">{git.branch}</span>
                {gitDirty > 0 && <span className="text-amber-400">●</span>}
                {git.ahead ? <span className="text-emerald-400">↑{git.ahead}</span> : null}
                {git.behind ? <span className="text-sky-400">↓{git.behind}</span> : null}
              </span>
            </TooltipTrigger>
            <TooltipContent side="top">
              <div className="text-[11px] leading-snug space-y-0.5">
                <div>Branch: <span className="font-mono">{git.branch}</span></div>
                {git.modified ? <div>{git.modified} modified</div> : null}
                {git.staged ? <div>{git.staged} staged</div> : null}
                {git.untracked ? <div>{git.untracked} untracked</div> : null}
                {git.ahead ? <div>{git.ahead} ahead of remote</div> : null}
                {git.behind ? <div>{git.behind} behind remote</div> : null}
                {!gitDirty && !git.ahead && !git.behind ? <div>Clean working tree.</div> : null}
              </div>
            </TooltipContent>
          </Tooltip>
        </>
      )}
      <span className="opacity-40">·</span>
      <span className="inline-flex items-center gap-1 truncate max-w-[420px]">
        <TypeIcon className={cn('h-2.5 w-2.5', activeFilePath ? typeColor : 'text-muted-foreground')} />
        <span className="truncate">{activeFilePath ?? 'No file'}</span>
        {dirtyCount > 0 && (
          <span className="ml-1 text-foreground/80">({dirtyCount} unsaved)</span>
        )}
      </span>
      <span className="ml-auto inline-flex items-center gap-3">
        {stats && (
          <>
            <span>{stats.file_count.toLocaleString()} files</span>
            <span className="opacity-40">·</span>
            <span>{stats.symbol_count.toLocaleString()} symbols</span>
            <span className="opacity-40">·</span>
          </>
        )}
        {/* Language + LSP status — single chip with a tooltip explaining
            what 'syntax only' means so the user isn't left wondering why
            their PHP file lacks completion. */}
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              className={cn(
                'inline-flex items-center gap-1 cursor-default',
                lang.lspSupported ? 'text-emerald-500/90' : 'text-amber-500/80',
              )}
            >
              {lang.lspSupported ? (
                <Activity className="h-2.5 w-2.5" />
              ) : (
                <Languages className="h-2.5 w-2.5" />
              )}
              <span>
                {lang.label}
                {!activeFilePath ? '' : lang.lspSupported ? ' · LSP' : ' · syntax only'}
              </span>
            </span>
          </TooltipTrigger>
          <TooltipContent side="top" className="max-w-[260px]">
            {lang.lspSupported ? (
              <span>Full IntelliSense — completion · hover · Ctrl+Click · diagnostics.</span>
            ) : activeFilePath ? (
              <span>
                Syntax highlight only. {lang.label} IntelliSense (completion / go-to-definition)
                needs an external LSP — coming in v1.1.
              </span>
            ) : (
              <span>Open a file to see language status.</span>
            )}
          </TooltipContent>
        </Tooltip>
      </span>
    </footer>
  );
}
