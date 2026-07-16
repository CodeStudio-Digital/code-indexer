/** Working-tree pane: virtualized status groups plus the inline commit box. */
import { Loader2 } from 'lucide-react';
import type { GitStatusCounts } from '@mcp/api-bus';
import { CommitBox } from './CommitBox.js';
import {
  VirtualizedChangesList,
  type GitChangeGroups,
  type GitChangeSections,
} from './VirtualizedChangesList.js';
import type { GitStatus, GitStatusFile } from './use-git-window.js';

interface ChangesPaneProps {
  projectId: number;
  repoPath?: string;
  status: GitStatus | null;
  error: string | null;
  groups: GitChangeGroups;
  counts: GitStatusCounts | null;
  openSections: GitChangeSections;
  setOpenSections: React.Dispatch<React.SetStateAction<GitChangeSections>>;
  showDiff: (file: GitStatusFile) => void | Promise<void>;
  onStage: (paths: string[]) => void | Promise<void>;
  onUnstage: (paths: string[]) => void | Promise<void>;
  onDiscard: (paths: string[]) => void | Promise<void>;
  onCommitted: () => void;
}

export function ChangesPane({
  projectId,
  repoPath,
  status,
  error,
  groups,
  counts,
  openSections,
  setOpenSections,
  showDiff,
  onStage,
  onUnstage,
  onDiscard,
  onCommitted,
}: ChangesPaneProps) {
  if (!status && !error) {
    return (
      <div className="grid flex-1 place-items-center text-[11px] text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin opacity-60" />
      </div>
    );
  }

  const total = counts?.total ?? groups.staged.length + groups.unstaged.length + groups.untracked.length;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <VirtualizedChangesList
        projectId={projectId}
        repoPath={repoPath}
        groups={groups}
        total={total}
        warnings={status?.partialWarnings ?? []}
        openSections={openSections}
        setOpenSections={setOpenSections}
        showDiff={showDiff}
        onStage={onStage}
        onUnstage={onUnstage}
        onDiscard={onDiscard}
      />
      <CommitBox
        projectId={projectId}
        repoPath={repoPath}
        stagedCount={groups.staged.length}
        upstream={status?.upstream ?? null}
        onCommitted={onCommitted}
      />
    </div>
  );
}
