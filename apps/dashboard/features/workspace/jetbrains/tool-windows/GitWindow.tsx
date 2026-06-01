/**
 * Git tool window — full IDE-style git surface for the project's
 * `root_path`. Sub-tabs split responsibilities so each view stays
 * focused:
 *
 *   - Changes  → working-tree status (stage / unstage / commit / discard)
 *   - Branches → list locals + remotes, checkout, create, delete, merge
 *   - History  → linear commit log per branch, context menu for
 *                cherry-pick / revert / reset
 *   - AI       → natural-language → plan of git commands → user confirm
 *                → executed sequentially, per-step results inline
 *
 * Diffs render in editor tabs (`openDiff` from workspace store). The
 * shared `notARepo` notice + branch header live in this container so
 * sub-views start with the assumption that we ARE in a git repo.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Archive,
  Check,
  ChevronDown,
  ChevronRight,
  GitBranch,
  GitCommit as GitCommitIcon,
  History,
  Loader2,
  Minus,
  Plus,
  RefreshCw,
  Sparkles,
  Trash2,
  Undo2,
} from 'lucide-react';
import { apiCall } from '../../../../lib/api-client.js';
import { useWorkspaceStore } from '../../../../state/workspace.js';
import { Button } from '../../../../components/ui/button.js';
import { confirm, toast } from '../../../../components/ui/prompt-dialog.js';
import { ToolWindowFrame } from '../ToolWindowFrame.js';
import { cn } from '../../../../lib/utils.js';
import { BranchesView } from './git/BranchesView.js';
import { HistoryView } from './git/HistoryView.js';
import { GitPromptView } from './git/GitPromptView.js';
import { StashView } from './git/StashView.js';
import { CommitDialog } from './git/CommitDialog.js';

type GitTab = 'changes' | 'branches' | 'history' | 'stash' | 'ai';

interface GitStatusFile {
  path: string;
  state: string;
  staged: boolean;
}

interface GitStatus {
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  files: GitStatusFile[];
  repoRoot: string | null;
  notARepo: boolean;
}

interface GitWindowProps {
  projectId: number;
  onClose?: () => void;
}

function fileKind(state: string): { letter: string; color: string } {
  switch (state) {
    case 'modified': return { letter: 'M', color: 'text-amber-500' };
    case 'added':    return { letter: 'A', color: 'text-emerald-500' };
    case 'deleted':  return { letter: 'D', color: 'text-destructive' };
    case 'renamed':  return { letter: 'R', color: 'text-cyan-400' };
    case 'copied':   return { letter: 'C', color: 'text-cyan-400' };
    case 'untracked':return { letter: '?', color: 'text-muted-foreground' };
    case 'unmerged': return { letter: '!', color: 'text-destructive' };
    default:         return { letter: '·', color: 'text-muted-foreground' };
  }
}

export function GitWindow({ projectId, onClose }: GitWindowProps) {
  const { t } = useTranslation('workspace');
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [commitOpen, setCommitOpen] = useState(false);
  const [openSections, setOpenSections] = useState({ staged: true, unstaged: true, untracked: false });
  const [tab, setTab] = useState<GitTab>('changes');
  const openDiff = useWorkspaceStore((s) => s.openDiff);

  const showDiff = useCallback(
    async (file: GitStatusFile) => {
      try {
        const r = await apiCall<{ patch: string }>('projectGit.diff', {
          projectId,
          path: file.path,
          staged: file.staged,
        });
        openDiff({
          kind: 'diff',
          projectId,
          path: `diff:${file.staged ? 'staged' : 'unstaged'}:${file.path}`,
          title: file.staged
            ? t('git.stagedDiffTitle', { file: file.path.split('/').pop() ?? file.path })
            : t('git.diffTitle', { file: file.path.split('/').pop() ?? file.path }),
          patch: r.patch,
          source: file.staged ? 'git-staged' : 'git-unstaged',
        });
      } catch (err) {
        toast.error(t('git.diffFailed'), {
          description: err instanceof Error ? err.message : String(err),
        });
      }
    },
    [projectId, openDiff, t],
  );

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const s = await apiCall<GitStatus>('projectGit.status', { projectId });
      setStatus(s);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const groups = useMemo(() => {
    const staged: GitStatusFile[] = [];
    const unstaged: GitStatusFile[] = [];
    const untracked: GitStatusFile[] = [];
    for (const f of status?.files ?? []) {
      if (f.staged) staged.push(f);
      else if (f.state === 'untracked') untracked.push(f);
      else unstaged.push(f);
    }
    return { staged, unstaged, untracked };
  }, [status]);

  const onStage = async (paths: string[]) => {
    try {
      await apiCall('projectGit.stage', { projectId, paths });
      await reload();
    } catch (err) {
      toast.error(t('git.stageFailed'), {
        description: err instanceof Error ? err.message : String(err),
      });
    }
  };
  const onUnstage = async (paths: string[]) => {
    try {
      await apiCall('projectGit.unstage', { projectId, paths });
      await reload();
    } catch (err) {
      toast.error(t('git.unstageFailed'), {
        description: err instanceof Error ? err.message : String(err),
      });
    }
  };
  const onDiscard = async (paths: string[]) => {
    const ok = await confirm({
      title: t(paths.length === 1 ? 'git.discardTitle_one' : 'git.discardTitle_other', { count: paths.length }),
      description:
        paths.length === 1
          ? t('git.discardDescription_one', { path: paths[0] })
          : t('git.discardDescription_other', { count: paths.length }),
      confirmLabel: t('git.discard'),
      tone: 'destructive',
    });
    if (!ok) return;
    try {
      await apiCall('projectGit.discard', { projectId, paths });
      await reload();
      toast.success(t('git.discarded'), {
        description: paths.length === 1 ? paths[0] : t('git.filesReverted', { count: paths.length }),
      });
    } catch (err) {
      toast.error(t('git.discardFailed'), {
        description: err instanceof Error ? err.message : String(err),
      });
    }
  };

  if (status?.notARepo) {
    return (
      <ToolWindowFrame title="Git" onClose={onClose}>
        <div className="h-full grid place-items-center px-6 text-center text-muted-foreground gap-2">
          <GitBranch className="h-5 w-5 opacity-50" />
          <p className="text-[11.5px]">
            {t('git.notRepo')}
            <br />
            {t('git.initHint')}
          </p>
        </div>
      </ToolWindowFrame>
    );
  }

  return (
    <>
      <ToolWindowFrame
        title="Git"
        onClose={onClose}
        actions={
          <>
            <Button
              variant="ghost"
              size="icon"
              className="h-5 w-5 text-muted-foreground hover:text-foreground"
              onClick={() => void reload()}
              aria-label={t('git.refresh')}
            >
              {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-5 w-5 text-muted-foreground hover:text-foreground"
              onClick={() => setCommitOpen(true)}
              disabled={groups.staged.length === 0}
              aria-label={t('git.commit')}
              title={t('git.commitStaged')}
            >
              <GitCommitIcon className="h-3 w-3" />
            </Button>
          </>
        }
      >
        <div className="h-full flex flex-col min-h-0">
          {/* Branch header — always visible regardless of active tab.
              Anchors the panel to the current repo state so the user
              never wonders "which branch is the History/AI tab
              talking about?". */}
          {status && (
            <div className="shrink-0 px-2.5 py-1.5 border-b text-[11px] flex items-center gap-2">
              <GitBranch className="h-3 w-3 text-primary" />
              <span className="font-medium truncate">{status.branch ?? t('git.detachedHead')}</span>
              {status.upstream && (
                <span className="text-muted-foreground/70 truncate">→ {status.upstream}</span>
              )}
              <span className="ml-auto flex items-center gap-2 text-muted-foreground">
                {status.ahead > 0 && <span>↑ {status.ahead}</span>}
                {status.behind > 0 && <span>↓ {status.behind}</span>}
              </span>
            </div>
          )}

          {/* Sub-tab nav — narrow, icon+label. The selected tab gets a
              top accent stripe + filled chip to match the IDE-rail
              convention elsewhere in the workspace. */}
          <GitTabNav active={tab} onChange={setTab} />

          {error && tab === 'changes' && (
            <div className="px-3 py-2 text-[11px] text-destructive shrink-0">{error}</div>
          )}

          {tab === 'changes' && (
            <ChangesPane
              status={status}
              error={error}
              groups={groups}
              openSections={openSections}
              setOpenSections={setOpenSections}
              showDiff={showDiff}
              onStage={onStage}
              onUnstage={onUnstage}
              onDiscard={onDiscard}
            />
          )}
          {tab === 'branches' && (
            <BranchesView projectId={projectId} onMutated={() => void reload()} />
          )}
          {tab === 'history' && (
            <HistoryView projectId={projectId} onMutated={() => void reload()} />
          )}
          {tab === 'stash' && (
            <StashView projectId={projectId} onMutated={() => void reload()} />
          )}
          {tab === 'ai' && (
            <GitPromptView projectId={projectId} onMutated={() => void reload()} />
          )}
        </div>
      </ToolWindowFrame>
      {commitOpen && (
        <CommitDialog
          projectId={projectId}
          stagedCount={groups.staged.length}
          onClose={() => setCommitOpen(false)}
          onCommitted={() => {
            setCommitOpen(false);
            void reload();
          }}
        />
      )}
    </>
  );
}

interface GitTabNavProps {
  active: GitTab;
  onChange: (t: GitTab) => void;
}

/**
 * Narrow sub-tab strip. Each tab is icon + short label. Active tab
 * gets a top accent stripe (matches the rail / IDE convention).
 *
 * Order matters: Changes first because that's the most common
 * action (stage + commit), Branches second (switch/checkout is
 * second-most), History for archeology, AI last because it's the
 * "I don't know the git command" escape hatch.
 */
function GitTabNav({ active, onChange }: GitTabNavProps) {
  const { t } = useTranslation('workspace');
  const tabs: { id: GitTab; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
    { id: 'changes', label: t('git.tabs.changes'), icon: GitCommitIcon },
    { id: 'branches', label: t('git.tabs.branches'), icon: GitBranch },
    { id: 'history', label: t('git.tabs.history'), icon: History },
    { id: 'stash', label: t('git.tabs.stash'), icon: Archive },
    { id: 'ai', label: t('git.tabs.ai'), icon: Sparkles },
  ];
  return (
    <div className="shrink-0 flex items-stretch border-b bg-card/30">
      {tabs.map(({ id, label, icon: Icon }) => {
        const isActive = active === id;
        return (
          <button
            key={id}
            type="button"
            onClick={() => onChange(id)}
            className={cn(
              'relative flex items-center gap-1.5 px-3 py-1.5 text-[11px] transition-colors',
              isActive
                ? 'text-foreground'
                : 'text-muted-foreground hover:text-foreground hover:bg-muted/40',
            )}
          >
            <Icon className={cn('h-3 w-3', isActive && id === 'ai' && 'text-primary')} />
            <span className="font-medium">{label}</span>
            {isActive && (
              <span className="absolute inset-x-1 top-0 h-[2px] bg-primary rounded-full" />
            )}
          </button>
        );
      })}
    </div>
  );
}

interface ChangesPaneProps {
  status: GitStatus | null;
  error: string | null;
  groups: {
    staged: GitStatusFile[];
    unstaged: GitStatusFile[];
    untracked: GitStatusFile[];
  };
  openSections: { staged: boolean; unstaged: boolean; untracked: boolean };
  setOpenSections: React.Dispatch<
    React.SetStateAction<{ staged: boolean; unstaged: boolean; untracked: boolean }>
  >;
  showDiff: (file: GitStatusFile) => void | Promise<void>;
  onStage: (paths: string[]) => void | Promise<void>;
  onUnstage: (paths: string[]) => void | Promise<void>;
  onDiscard: (paths: string[]) => void | Promise<void>;
}

/**
 * Working-tree pane: three collapsible sections (staged / unstaged /
 * untracked) with row-level + bulk actions. The empty state asks the
 * user to make some changes; the inverse (everything committed) shows
 * a friendly "clean tree" message instead.
 */
function ChangesPane({
  status,
  error,
  groups,
  openSections,
  setOpenSections,
  showDiff,
  onStage,
  onUnstage,
  onDiscard,
}: ChangesPaneProps) {
  const { t } = useTranslation('workspace');
  const total =
    groups.staged.length + groups.unstaged.length + groups.untracked.length;

  if (!status && !error) {
    return (
      <div className="flex-1 grid place-items-center text-[11px] text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin opacity-60" />
      </div>
    );
  }
  if (status && total === 0) {
    return (
      <div className="flex-1 grid place-items-center px-6 text-center text-muted-foreground gap-2">
        <Check className="h-5 w-5 opacity-50" />
        <p className="text-[11.5px]">{t('git.cleanTree')}</p>
      </div>
    );
  }

  return (
    <div className="flex-1 min-h-0 overflow-y-auto">
      {groups.staged.length > 0 && (
        <Section
          title={t('git.staged', { count: groups.staged.length })}
          open={openSections.staged}
          onToggle={() => setOpenSections((s) => ({ ...s, staged: !s.staged }))}
          bulkAction={
            <button
              type="button"
              onClick={() => void onUnstage(groups.staged.map((f) => f.path))}
              className="text-[10px] text-muted-foreground hover:text-foreground"
              title={t('git.unstageAll')}
            >
              {t('git.unstageAll')}
            </button>
          }
        >
          {groups.staged.map((f) => (
            <FileRow
              key={`s-${f.path}`}
              file={f}
              onClick={() => void showDiff(f)}
              actions={
                <RowButton
                  icon={Minus}
                  title={t('git.unstage')}
                  onClick={() => void onUnstage([f.path])}
                />
              }
            />
          ))}
        </Section>
      )}

      {groups.unstaged.length > 0 && (
        <Section
          title={t('git.changes', { count: groups.unstaged.length })}
          open={openSections.unstaged}
          onToggle={() => setOpenSections((s) => ({ ...s, unstaged: !s.unstaged }))}
          bulkAction={
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => void onDiscard(groups.unstaged.map((f) => f.path))}
                className="text-[10px] text-muted-foreground hover:text-destructive"
                title={t('git.discardAllUnstaged')}
              >
                {t('git.discardAll')}
              </button>
              <button
                type="button"
                onClick={() => void onStage(groups.unstaged.map((f) => f.path))}
                className="text-[10px] text-muted-foreground hover:text-foreground"
                title={t('git.stageAll')}
              >
                {t('git.stageAll')}
              </button>
            </div>
          }
        >
          {groups.unstaged.map((f) => (
            <FileRow
              key={`u-${f.path}`}
              file={f}
              onClick={() => void showDiff(f)}
              actions={
                <>
                  <RowButton
                    icon={Undo2}
                    title={t('git.discard')}
                    destructive
                    onClick={() => void onDiscard([f.path])}
                  />
                  <RowButton
                    icon={Plus}
                    title={t('git.stage')}
                    onClick={() => void onStage([f.path])}
                  />
                </>
              }
            />
          ))}
        </Section>
      )}

      {groups.untracked.length > 0 && (
        <Section
          title={t('git.untracked', { count: groups.untracked.length })}
          open={openSections.untracked}
          onToggle={() =>
            setOpenSections((s) => ({ ...s, untracked: !s.untracked }))
          }
          bulkAction={
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => void onDiscard(groups.untracked.map((f) => f.path))}
                className="text-[10px] text-muted-foreground hover:text-destructive"
                title={t('git.deleteAllUntracked')}
              >
                {t('git.deleteAll')}
              </button>
              <button
                type="button"
                onClick={() => void onStage(groups.untracked.map((f) => f.path))}
                className="text-[10px] text-muted-foreground hover:text-foreground"
                title={t('git.stageAllUntracked')}
              >
                {t('git.stageAll')}
              </button>
            </div>
          }
        >
          {groups.untracked.map((f) => (
            <FileRow
              key={`?-${f.path}`}
              file={f}
              actions={
                <>
                  <RowButton
                    icon={Trash2}
                    title={t('git.deleteFile')}
                    destructive
                    onClick={() => void onDiscard([f.path])}
                  />
                  <RowButton
                    icon={Plus}
                    title={t('git.stage')}
                    onClick={() => void onStage([f.path])}
                  />
                </>
              }
            />
          ))}
        </Section>
      )}
    </div>
  );
}

interface SectionProps {
  title: string;
  open: boolean;
  onToggle: () => void;
  bulkAction?: React.ReactNode;
  children: React.ReactNode;
}

function Section({ title, open, onToggle, bulkAction, children }: SectionProps) {
  return (
    <div>
      <div className="sticky top-0 z-[1] flex items-center gap-1 px-2.5 py-1 bg-card/80 backdrop-blur supports-[backdrop-filter]:bg-card/60 border-b">
        <button
          type="button"
          onClick={onToggle}
          className="flex items-center gap-1 text-[10px] uppercase tracking-[0.08em] text-muted-foreground hover:text-foreground"
        >
          {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
          <span className="font-semibold">{title}</span>
        </button>
        {bulkAction && <div className="ml-auto">{bulkAction}</div>}
      </div>
      {open && children}
    </div>
  );
}

function FileRow({
  file,
  actions,
  onClick,
}: {
  file: GitStatusFile;
  actions: React.ReactNode;
  onClick?: () => void;
}) {
  const { t } = useTranslation('workspace');
  const k = fileKind(file.state);
  return (
    <div
      className={cn(
        'group flex items-center gap-2 px-2.5 py-1 transition-colors border-b last:border-b-0 text-[11.5px]',
        onClick ? 'cursor-pointer hover:bg-muted/40' : 'hover:bg-muted/40',
      )}
      onClick={onClick}
      title={onClick ? t('git.openDiffFor', { path: file.path }) : file.path}
    >
      <span className={cn('font-mono text-[10px] w-3 shrink-0 text-center', k.color)}>
        {k.letter}
      </span>
      <span className="truncate flex-1">{file.path}</span>
      <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
        {actions}
      </div>
    </div>
  );
}

function RowButton({
  icon: Icon,
  title,
  onClick,
  destructive,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  onClick: () => void;
  destructive?: boolean;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className={cn(
        'h-5 w-5 grid place-items-center rounded-sm transition-colors',
        destructive
          ? 'text-muted-foreground hover:text-destructive hover:bg-destructive/10'
          : 'text-muted-foreground hover:text-foreground hover:bg-muted',
      )}
    >
      <Icon className="h-3 w-3" />
    </button>
  );
}

