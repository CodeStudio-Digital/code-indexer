/**
 * Read-only unified-diff viewer rendered inside the editor pane.
 * Backed by react-diff-view (already a dep) since Monaco's DiffEditor
 * needs both file revisions and we only carry the patch.
 *
 * The Git tool window opens diffs via `useWorkspaceStore.openDiff(...)`
 * with `source: 'git-unstaged' | 'git-staged'`. The editor pane
 * dispatches to DiffMount for those tabs and to MonacoMount for
 * regular files.
 */

import { useMemo } from 'react';
import {
  Diff,
  Hunk,
  parseDiff,
  type ChangeData,
  type HunkData,
  type ViewType,
} from 'react-diff-view';
import { GitCompare } from 'lucide-react';
import type { OpenDiff } from '../../../state/workspace.js';

interface DiffMountProps {
  diff: OpenDiff;
}

export function DiffMount({ diff }: DiffMountProps) {
  const files = useMemo(() => {
    try {
      return parseDiff(diff.patch || '');
    } catch {
      return [];
    }
  }, [diff.patch]);

  if (!diff.patch.trim()) {
    return (
      <div className="h-full grid place-items-center text-muted-foreground text-[12px] gap-2 px-4 text-center">
        <GitCompare className="h-5 w-5 opacity-50" />
        <span>No diff to show — the file matches HEAD.</span>
      </div>
    );
  }
  if (files.length === 0) {
    return (
      <div className="h-full grid place-items-center text-destructive text-[12px] px-4 text-center">
        Could not parse this diff. Run <code>git diff</code> in the terminal for the raw output.
      </div>
    );
  }

  const view: ViewType = 'split';

  return (
    <div className="h-full overflow-auto text-[12px] diff-block">
      {files.map((file) => (
        <div key={`${file.oldPath}→${file.newPath}`} className="border-b">
          <div className="px-3 py-1.5 sticky top-0 z-[1] bg-card/80 backdrop-blur border-b text-[11px] font-mono text-muted-foreground">
            <span className="text-foreground font-medium">{file.newPath || file.oldPath}</span>
            {file.oldPath && file.newPath && file.oldPath !== file.newPath && (
              <span className="ml-2 text-muted-foreground/70">← {file.oldPath}</span>
            )}
          </div>
          <Diff viewType={view} diffType={file.type} hunks={file.hunks ?? []}>
            {(hunks: HunkData[]) =>
              hunks.map((h: HunkData) => (
                <Hunk
                  key={`${file.newPath ?? file.oldPath}:${h.oldStart}:${h.newStart}`}
                  hunk={h as unknown as { changes: ChangeData[] } & HunkData}
                />
              ))
            }
          </Diff>
        </div>
      ))}
    </div>
  );
}
