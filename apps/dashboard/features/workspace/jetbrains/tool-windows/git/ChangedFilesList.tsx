/**
 * A scrollable list of changed files (status letter + path + ±counts),
 * each opening its diff on click. Shared by the commit preview and the
 * stash preview so both snapshots read identically.
 */

import { cn } from '../../../../../lib/utils.js';
import { fileKind } from './file-kind.js';

export interface ChangedFile {
  path: string;
  oldPath?: string;
  state: 'modified' | 'added' | 'deleted' | 'renamed' | 'copied';
  additions: number;
  deletions: number;
}

export function ChangedFilesList({
  files,
  onOpenFile,
}: {
  files: ChangedFile[];
  onOpenFile: (f: ChangedFile) => void;
}) {
  return (
    <div className="flex-1 min-h-0 overflow-y-auto">
      {files.map((f) => {
        const k = fileKind(f.state);
        return (
          <button
            key={f.path}
            type="button"
            onClick={() => onOpenFile(f)}
            className="w-full flex items-center gap-2 px-3 py-1 text-left text-[11.5px] hover:bg-muted/40 border-b last:border-b-0 transition-colors"
            title={f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}
          >
            <span className={cn('font-mono text-[10px] w-3 shrink-0 text-center', k.color)}>
              {k.letter}
            </span>
            <span className="truncate flex-1">{f.path}</span>
            <span className="shrink-0 flex items-center gap-1.5 text-[10px] font-mono">
              {f.additions > 0 && <span className="text-emerald-400">+{f.additions}</span>}
              {f.deletions > 0 && <span className="text-destructive">−{f.deletions}</span>}
            </span>
          </button>
        );
      })}
    </div>
  );
}
