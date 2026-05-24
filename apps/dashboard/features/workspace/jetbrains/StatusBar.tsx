/**
 * Status bar at the very bottom of the Workspace — IDE convention.
 *
 * Day-1 surface: active file path · indexed/total file count · LSP idle
 * indicator. Future: branch name, git diff stats, encoding, line-ending,
 * agent run state.
 */

import { Activity, Circle, FileCode2 } from 'lucide-react';
import { useApi } from '../../../hooks/useApi.js';
import { useWorkspaceStore } from '../../../state/workspace.js';

interface StatusBarProps {
  projectId: number;
  projectName: string;
}

export function StatusBar({ projectId, projectName }: StatusBarProps) {
  const activeFilePath = useWorkspaceStore((s) => s.activeFilePath);
  const dirtyCount = useWorkspaceStore((s) => s.openFiles.filter((f) => f.dirty).length);
  const { data: stats } = useApi<{ file_count: number; symbol_count: number; total_lines: number }>(
    `/projects/${projectId}/stats`,
  );

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
          <span className="ml-1 text-foreground/80">
            ({dirtyCount} unsaved)
          </span>
        )}
      </span>
      <span className="ml-auto inline-flex items-center gap-1">
        {stats && (
          <>
            <span>{stats.file_count.toLocaleString()} files</span>
            <span className="opacity-40">·</span>
            <span>{stats.symbol_count.toLocaleString()} symbols</span>
            <span className="opacity-40">·</span>
          </>
        )}
        <Activity className="h-2.5 w-2.5" />
        <span>LSP idle</span>
      </span>
    </footer>
  );
}
