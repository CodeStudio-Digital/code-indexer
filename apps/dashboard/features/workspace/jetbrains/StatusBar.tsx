/**
 * Status bar at the very bottom of the Workspace — IDE convention.
 *
 * Surface: project · git branch · active file · unsaved count ·
 * indexed/total file + symbol totals · language label (with LSP
 * support indicator). The LSP indicator pulls double duty as a hint:
 * green for TS/JS (full IntelliSense), amber for everything else
 * (syntax highlight only).
 *
 * The git-branch chip is interactive — clicking it opens a
 * JetBrains-style branch popover (`BranchPopover`) with checkout,
 * update, commit, push, new-branch, etc. The chip's hover tooltip is
 * preserved for at-a-glance state without committing to opening the
 * popover.
 */

import { memo, useState } from 'react';
import { Circle, GitBranch } from 'lucide-react';
import { useApi } from '../../../hooks/useApi.js';
import { useWorkspaceStore } from '../../../state/workspace.js';
import { Tooltip, TooltipContent, TooltipTrigger } from '../../../components/ui/tooltip.js';
import { Popover, PopoverContent, PopoverTrigger } from '../../../components/ui/popover.js';
import { cn } from '../../../lib/utils.js';
import { fileIconFor } from '../../../lib/file-icon.js';
import { BranchPopover } from './status-bar/BranchPopover.js';
import { IndexStatusSection } from './status-bar/IndexStatusSection.js';
import { LanguageChip } from './status-bar/LanguageChip.js';
import { AiCompleteChip } from './status-bar/AiCompleteChip.js';
import { CommitDialog } from './tool-windows/git/CommitDialog.js';

interface StatusBarProps {
  projectId: number;
  projectName: string;
}

interface GitStatusFile {
  path: string;
  state: 'modified' | 'added' | 'deleted' | 'renamed' | 'copied' | 'untracked' | 'ignored' | 'unmerged';
  staged: boolean;
}

interface GitStatusSummary {
  branch?: string | null;
  ahead?: number;
  behind?: number;
  files?: GitStatusFile[];
  notARepo?: boolean;
}

function StatusBarImpl({ projectId, projectName }: StatusBarProps) {
  const activeFilePath = useWorkspaceStore((s) => s.activeFilePath);
  const dirtyCount = useWorkspaceStore(
    (s) => s.openFiles.filter((f) => f.kind !== 'diff' && f.dirty).length,
  );
  // The indexing chip + file/symbol counters live in IndexStatusSection,
  // which owns the live `useIndexStatus` subscription — so progress frames
  // (~6×/s during a scan) re-render only that tiny section, not this footer
  // (and its git Popover/Tooltip subtree).
  // projectGit.status returns the branch + ahead/behind/dirty counters
  // so we can echo what JetBrains shows in the bottom-right corner.
  // `refetch` lets the branch popover poke this hook after any
  // operation (checkout / push / pull) so the chip re-syncs immediately
  // instead of waiting for the next navigation revalidation.
  const { data: git, refetch: refreshGit } = useApi<GitStatusSummary>(
    `/projects/${projectId}/git/status`,
  );

  const [popoverOpen, setPopoverOpen] = useState(false);
  const [commitOpen, setCommitOpen] = useState(false);

  const { Icon: TypeIcon, colorClass: typeColor } = fileIconFor(activeFilePath ?? '');
  // Reduce `files` once — gitDirty drives the amber dot, stagedCount
  // gates the Commit dialog's button. The handler returns one entry
  // per file per state (staged + working-tree), but for the dirty
  // indicator we only care if ANY non-staged change exists.
  const files = git?.files ?? [];
  const stagedCount = files.filter((f) => f.staged).length;
  const unstagedCount = files.filter((f) => !f.staged && f.state !== 'ignored').length;
  const gitDirty = stagedCount + unstagedCount;

  return (
    <footer className="h-5 shrink-0 border-t bg-card/60 flex items-center px-2 gap-3 text-[10px] text-muted-foreground select-none">
      <span className="inline-flex items-center gap-1 truncate">
        <Circle className="h-1.5 w-1.5 fill-green-500 text-green-500" />
        <span className="truncate max-w-[160px]">{projectName}</span>
      </span>
      {git?.branch && (
        <>
          <span className="opacity-40">·</span>
          {/* The chip serves two intents: hover → quick state tooltip,
              click → full JetBrains-style branch popover. Radix renders
              both off the same anchor without conflict because Tooltip
              uses pointer-enter/leave and Popover only opens on click. */}
          <Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
            <Tooltip>
              <TooltipTrigger asChild>
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    className={cn(
                      'inline-flex items-center gap-1 truncate max-w-[220px] rounded',
                      'hover:bg-muted/40 px-1 -mx-1 transition-colors',
                      popoverOpen && 'bg-muted/60',
                    )}
                  >
                    <GitBranch
                      className={cn(
                        'h-2.5 w-2.5',
                        gitDirty > 0 ? 'text-amber-400' : 'text-muted-foreground',
                      )}
                    />
                    <span className="truncate">{git.branch}</span>
                    {gitDirty > 0 && <span className="text-amber-400">●</span>}
                    {git.ahead ? <span className="text-emerald-400">↑{git.ahead}</span> : null}
                    {git.behind ? <span className="text-sky-400">↓{git.behind}</span> : null}
                  </button>
                </PopoverTrigger>
              </TooltipTrigger>
              <TooltipContent side="top">
                <div className="text-[11px] leading-snug space-y-0.5">
                  <div>Branch: <span className="font-mono">{git.branch}</span></div>
                  {stagedCount > 0 && <div>{stagedCount} staged</div>}
                  {unstagedCount > 0 && <div>{unstagedCount} unstaged / untracked</div>}
                  {git.ahead ? <div>{git.ahead} ahead of remote</div> : null}
                  {git.behind ? <div>{git.behind} behind remote</div> : null}
                  {!gitDirty && !git.ahead && !git.behind ? <div>Clean working tree.</div> : null}
                  <div className="text-muted-foreground/70 pt-1">Click for branch actions…</div>
                </div>
              </TooltipContent>
            </Tooltip>
            <PopoverContent
              side="top"
              align="start"
              sideOffset={6}
              className="p-0 overflow-hidden"
            >
              <BranchPopover
                projectId={projectId}
                onMutated={refreshGit}
                onRequestCommit={() => setCommitOpen(true)}
                onClose={() => setPopoverOpen(false)}
              />
            </PopoverContent>
          </Popover>
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
        <IndexStatusSection projectId={projectId} />
        {/* Language-intelligence tier for the active file: built-in TS
            service / installed LSP server (green), structural-index
            fallback (sky) or syntax-only (amber). */}
        <LanguageChip projectId={projectId} activeFilePath={activeFilePath} />
        <span className="opacity-40">·</span>
        <AiCompleteChip />
      </span>

      {commitOpen && (
        <CommitDialog
          projectId={projectId}
          stagedCount={stagedCount}
          onClose={() => setCommitOpen(false)}
          onCommitted={() => {
            setCommitOpen(false);
            refreshGit();
          }}
        />
      )}
    </footer>
  );
}

/** Memoized: only re-render when projectId/projectName change (parent churn). */
export const StatusBar = memo(StatusBarImpl);
