/**
 * Status bar at the very bottom of the Workspace — IDE convention.
 *
 * Surface: project · active file · unsaved count · indexed/total file
 * + symbol totals · language label (with LSP support indicator). The
 * LSP indicator pulls double duty as a hint: green for TS/JS (full
 * IntelliSense), amber for everything else (syntax highlight only).
 */

import { Activity, Circle, FileCode2, Languages } from 'lucide-react';
import { useApi } from '../../../hooks/useApi.js';
import { useWorkspaceStore } from '../../../state/workspace.js';
import { inferLanguage } from '../../../lib/language-detect.js';
import { Tooltip, TooltipContent, TooltipTrigger } from '../../../components/ui/tooltip.js';
import { cn } from '../../../lib/utils.js';

interface StatusBarProps {
  projectId: number;
  projectName: string;
}

export function StatusBar({ projectId, projectName }: StatusBarProps) {
  const activeFilePath = useWorkspaceStore((s) => s.activeFilePath);
  const dirtyCount = useWorkspaceStore(
    (s) => s.openFiles.filter((f) => f.kind !== 'diff' && f.dirty).length,
  );
  const { data: stats } = useApi<{ file_count: number; symbol_count: number; total_lines: number }>(
    `/projects/${projectId}/stats`,
  );

  const lang = inferLanguage(activeFilePath);

  return (
    <footer className="h-5 shrink-0 border-t bg-card/60 flex items-center px-2 gap-3 text-[10px] text-muted-foreground select-none">
      <span className="inline-flex items-center gap-1 truncate">
        <Circle className="h-1.5 w-1.5 fill-green-500 text-green-500" />
        <span className="truncate max-w-[160px]">{projectName}</span>
      </span>
      <span className="opacity-40">·</span>
      <span className="inline-flex items-center gap-1 truncate max-w-[420px]">
        <FileCode2 className="h-2.5 w-2.5" />
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
