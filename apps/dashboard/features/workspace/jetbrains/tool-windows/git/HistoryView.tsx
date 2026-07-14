/**
 * History view — topological commit graph for all refs by default (or a
 * specific branch when the user picks one from the dropdown).
 *
 * Per-commit context menu (right-click row or icon button):
 *   - Cherry-pick onto the current branch
 *   - Revert (creates a new commit that undoes the selected one)
 *   - Reset HEAD to this commit (soft / mixed / hard sub-menu)
 *   - Copy SHA
 *
 * The list uses real offset pagination. The first page stays small and an
 * explicit "Load more" appends older commits without replacing visible rows.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, RefreshCw } from 'lucide-react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { apiCall } from '../../../../../lib/api-client.js';
import { useGitRevision } from '../../../../../state/git-revision.js';
import { Button } from '../../../../../components/ui/button.js';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../../../../components/ui/select.js';
import { confirm, prompt, toast } from '../../../../../components/ui/prompt-dialog.js';
import { CommitRow, type Commit } from './CommitRow.js';
import { usePaginatedGitLog } from './use-paginated-git-log.js';
import { buildGitGraph } from './git-graph.js';

interface GitRunResult {
  command: string;
  args: string[];
  ok: boolean;
  code: number;
  stdout: string;
  stderr: string;
}

interface GitBranchSummary {
  name: string;
  isCurrent: boolean;
  isRemote: boolean;
}

interface HistoryViewProps {
  active?: boolean;
  projectId: number;
  /** Selected git root (submodule / nested repo); undefined = main repo. */
  repoPath?: string;
  onMutated: () => void;
  /** A sequencer op is mid-flight — disable cherry-pick/revert/reset. */
  opInProgress?: boolean;
}

const LOG_PAGE_SIZE = 60;

export function HistoryView({ active = true, projectId, repoPath, onMutated, opInProgress }: HistoryViewProps) {
  const { t } = useTranslation('workspace');
  const [branches, setBranches] = useState<GitBranchSummary[]>([]);
  const [branch, setBranch] = useState<string>('__all__');
  const [branchesLoading, setBranchesLoading] = useState(true);
  const [branchesError, setBranchesError] = useState<string | null>(null);
  const gitRev = useGitRevision((s) => s.revByProject[projectId] ?? 0);
  const {
    commits,
    loading,
    loadingMore,
    error: logError,
    hasMore,
    reload: reloadCommits,
    loadMore,
  } = usePaginatedGitLog({
    enabled: active,
    projectId,
    repoPath,
    branch: branch === '__all__' || branch === '__current__' ? undefined : branch,
    all: branch === '__all__',
    reloadKey: gitRev,
    pageSize: LOG_PAGE_SIZE,
  });

  const reloadBranches = useCallback(async () => {
    setBranchesLoading(true);
    try {
      const bs = await apiCall<GitBranchSummary[]>('projectGit.branchesDetailed', {
        projectId,
        repoPath,
        includeRemote: true,
        rev: gitRev,
      });
      setBranches(bs);
      setBranchesError(null);
    } catch (e) {
      setBranchesError(e instanceof Error ? e.message : String(e));
    } finally {
      setBranchesLoading(false);
    }
  }, [projectId, repoPath, gitRev]);

  const reload = useCallback(async () => {
    await Promise.all([reloadBranches(), reloadCommits()]);
  }, [reloadBranches, reloadCommits]);

  useEffect(() => {
    if (active) void reloadBranches();
  }, [active, reloadBranches]);

  const error = logError ?? branchesError;

  const currentBranchName = useMemo(
    () => branches.find((b) => b.isCurrent)?.name ?? null,
    [branches],
  );
  const graph = useMemo(() => buildGitGraph(commits), [commits]);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const virtualizer = useVirtualizer({
    count: commits.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 44,
    overscan: 12,
  });

  const cherryPick = async (c: Commit) => {
    try {
      const r = await apiCall<GitRunResult>('projectGit.cherryPick', {
        projectId,
        repoPath,
        commits: [c.sha],
      });
      if (r.ok) {
        toast.success(t('git.history.cherryPicked', { sha: c.shortSha }));
      } else {
        toast.error(t('git.history.cherryPickIssues'), {
          description: r.stderr.trim().slice(0, 300) || r.stdout.trim().slice(0, 300),
        });
      }
      await reload();
      onMutated();
    } catch (e) {
      toast.error(t('git.history.cherryPickFailed'), { description: e instanceof Error ? e.message : String(e) });
    }
  };

  const revert = async (c: Commit) => {
    const ok = await confirm({
      title: t('git.history.revertTitle', { sha: c.shortSha }),
      description: t('git.history.revertBody', { subject: c.subject.slice(0, 80) }),
      confirmLabel: t('git.history.revert'),
    });
    if (!ok) return;
    try {
      const r = await apiCall<GitRunResult>('projectGit.revert', { projectId, repoPath, commit: c.sha });
      if (r.ok) {
        toast.success(t('git.history.reverted', { sha: c.shortSha }));
      } else {
        toast.error(t('git.history.revertIssues'), {
          description: r.stderr.trim().slice(0, 300) || r.stdout.trim().slice(0, 300),
        });
      }
      await reload();
      onMutated();
    } catch (e) {
      toast.error(t('git.history.revertFailed'), { description: e instanceof Error ? e.message : String(e) });
    }
  };

  const reset = async (c: Commit, mode: 'soft' | 'mixed' | 'hard') => {
    const labelByMode = {
      soft: t('git.history.resetSoft'),
      mixed: t('git.history.resetMixed'),
      hard: t('git.history.resetHard'),
    };
    const ok = mode === 'hard'
      ? (await prompt({
          title: t('git.history.resetHardTitle', { sha: c.shortSha }),
          description: t('git.history.resetHardBody'),
          placeholder: 'RESET HARD',
          confirmLabel: t('git.history.resetHardConfirm'),
          validate: (value) => value === 'RESET HARD' ? null : t('git.history.resetHardValidation'),
        })) === 'RESET HARD'
      : await confirm({
          title: t('git.history.resetTitle', { sha: c.shortSha }),
          description: labelByMode[mode],
          confirmLabel: `Reset --${mode}`,
        });
    if (!ok) return;
    try {
      const r = await apiCall<GitRunResult>('projectGit.reset', { projectId, repoPath, target: c.sha, mode });
      if (r.ok) {
        toast.success(t('git.history.resetDone', { mode, sha: c.shortSha }));
      } else {
        toast.error(t('git.history.resetIssues'), {
          description: r.stderr.trim().slice(0, 300) || r.stdout.trim().slice(0, 300),
        });
      }
      await reload();
      onMutated();
    } catch (e) {
      toast.error(t('git.history.resetFailed'), { description: e instanceof Error ? e.message : String(e) });
    }
  };

  return (
    <div className="h-full flex flex-col min-h-0">
      <div className="shrink-0 px-2 py-1.5 border-b flex items-center gap-1.5">
        <Select value={branch} onValueChange={setBranch}>
          <SelectTrigger className="h-6 text-[11px] flex-1 min-w-0">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__all__">{t('git.history.allBranches')}</SelectItem>
            <SelectItem value="__current__">
              {t('git.history.current', { branch: currentBranchName ?? 'HEAD' })}
            </SelectItem>
            {branches.map((b) => (
              <SelectItem key={b.name} value={b.name}>
                {b.name}
                {b.isRemote && <span className="text-muted-foreground"> ({t('git.history.remote')})</span>}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
          {t('git.history.loaded', { count: commits.length })}
        </span>
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6"
          onClick={() => void reload()}
          title={t('git.refresh')}
        >
          {loading || branchesLoading ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
        </Button>
      </div>

      {error && <div className="px-2 py-1 text-[11px] text-destructive shrink-0">{error}</div>}

      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto">
        {!loading && commits.length === 0 && !error && (
          <div className="text-center text-[11px] text-muted-foreground p-4">{t('git.history.noCommits')}</div>
        )}
        {commits.length > 0 && (
          <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
            {virtualizer.getVirtualItems().map((v) => {
              const c = commits[v.index];
              return (
                <div
                  key={c.sha}
                  data-index={v.index}
                  ref={virtualizer.measureElement}
                  style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${v.start}px)` }}
                >
                  <CommitRow
                    commit={c}
                    graph={graph.rows[v.index]}
                    graphMaxLanes={graph.maxLanes}
                    disabled={opInProgress}
                    onCherryPick={() => void cherryPick(c)}
                    onRevert={() => void revert(c)}
                    onReset={(mode) => void reset(c, mode)}
                  />
                </div>
              );
            })}
          </div>
        )}
        {commits.length > 0 && hasMore && (
          <div className="sticky bottom-0 flex justify-center border-t bg-background/95 p-1.5 backdrop-blur">
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-3 text-[11px]"
              disabled={loadingMore}
              onClick={() => void loadMore()}
            >
              {loadingMore && <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />}
              {t('git.history.loadOlder')}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
