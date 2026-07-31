/**
 * Git Log surface — opened in the editor content area when the user
 * clicks a branch in the Branches tab. Lists every commit on that
 * branch (left) with a live commit preview (right), JetBrains-style.
 *
 * Distinct from the History sub-tab (which lives in the narrow Git tool
 * window): this is the roomy, dedicated surface where selecting a commit
 * shows its files + message and clicking a file opens its diff.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import { ArrowRightLeft, GitBranch, Loader2, RefreshCw } from 'lucide-react';
import { apiCall } from '../../../../../lib/api-client.js';
import { Button } from '../../../../../components/ui/button.js';
import { confirm, prompt, toast } from '../../../../../components/ui/prompt-dialog.js';
import { useWorkspaceStore, type OpenGitLog } from '../../../../../state/workspace.js';
import { requestGitReload, onGitReloadRequest } from '../../../editor/conflict-registry.js';
import { CommitRow, type Commit } from './CommitRow.js';
import { CommitDetailPanel } from './CommitDetailPanel.js';
import { checkoutBranch } from './branch-actions.js';
import { usePaginatedGitLog } from './use-paginated-git-log.js';
import { buildGitGraph } from './git-graph.js';
import { useGitRevision } from '../../../../../state/git-revision.js';

interface GitRunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

const LOG_PAGE_SIZE = 80;

export function GitLogView({ tab }: { tab: OpenGitLog }) {
  const { t } = useTranslation('workspace');
  const { projectId, branch, isRemote, repoPath } = tab;
  const gitRev = useGitRevision((state) => state.revByProject[projectId] ?? 0);
  const initialViewState = useRef(tab.viewState ?? {
    selectedSha: null,
    scrollOffset: 0,
    limit: 120,
  });
  const [selected, setSelected] = useState<string | null>(initialViewState.current.selectedSha);
  const [currentBranch, setCurrentBranch] = useState<string | null>(null);
  const [opInProgress, setOpInProgress] = useState(false);
  const setGitLogViewState = useWorkspaceStore((s) => s.setGitLogViewState);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const {
    commits,
    loading,
    loadingMore,
    error,
    hasMore,
    reload: reloadCommits,
    loadMore,
  } = usePaginatedGitLog({ projectId, repoPath, branch, pageSize: LOG_PAGE_SIZE, reloadKey: gitRev });
  const commitsRef = useRef(commits);
  commitsRef.current = commits;
  const graph = useMemo(() => buildGitGraph(commits), [commits]);

  const reloadStatus = useCallback(async () => {
    try {
      const [status, ms] = await Promise.all([
        apiCall<{ branch: string | null }>('projectGit.status', { projectId, repoPath, includeFiles: false }),
        apiCall<{ kind: string | null }>('projectGit.mergeState', { projectId, repoPath }),
      ]);
      setCurrentBranch(status.branch);
      setOpInProgress(ms.kind !== null);
    } catch {
      // The paginated log owns its visible error. Status failures only affect
      // action gating and will be retried by the explicit refresh/reload event.
    }
  }, [projectId, repoPath]);

  const reload = useCallback(async () => {
    await Promise.all([reloadStatus(), reloadCommits()]);
  }, [reloadCommits, reloadStatus]);

  useEffect(() => {
    void reloadStatus();
  }, [reloadStatus]);

  // Keep the commit-action gating fresh when a conflict is started/resolved
  // from another surface (the 3-pane merge editor, the Git window banner).
  useEffect(() => onGitReloadRequest(() => void reload()), [reload]);

  const isCurrent = !isRemote && currentBranch === branch;

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const scrollOffsetRef = useRef(initialViewState.current.scrollOffset);
  const restoredScroll = useRef(false);
  const virtualizer = useVirtualizer({
    count: commits.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 44,
    overscan: 12,
  });

  // The retained Git stack normally keeps this surface alive. Persist a small
  // fallback snapshot as well for pane reorientation/project teardown.
  useEffect(() => () => {
    setGitLogViewState(projectId, tab.path, {
      selectedSha: selectedRef.current,
      scrollOffset: scrollOffsetRef.current,
      limit: Math.max(LOG_PAGE_SIZE, commitsRef.current.length),
    });
  }, [projectId, setGitLogViewState, tab.path]);

  useEffect(() => {
    if (restoredScroll.current || loading || commits.length === 0) return;
    restoredScroll.current = true;
    const offset = initialViewState.current.scrollOffset;
    if (offset <= 0) return;
    const frame = requestAnimationFrame(() => virtualizer.scrollToOffset(offset, { align: 'start' }));
    return () => cancelAnimationFrame(frame);
  }, [commits.length, loading, virtualizer]);

  const switchTo = async () => {
    try {
      const result = await checkoutBranch(projectId, branch, isRemote, repoPath, {
        confirmSmartCheckout: (blocker) => confirm({
          title: t('git.smartCheckoutTitle'),
          description: t(blocker === 'untracked'
            ? 'git.smartCheckoutUntrackedDescription'
            : 'git.smartCheckoutDescription', { branch }),
          confirmLabel: t('git.smartCheckoutConfirm'),
        }),
      });
      if (!result) return;
      if (result.restoreConflicts) {
        toast.warning(t('git.smartCheckoutConflicts'), {
          description: t('git.smartCheckoutConflictsDescription', {
            branch: result.name,
            stash: result.stashRef ?? t('git.smartCheckoutUnknownStash'),
          }),
          duration: 10_000,
        });
        requestGitReload();
      } else {
        toast.success(t('git.branchSwitched', { branch: result.name }));
      }
      await reload();
    } catch (e) {
      toast.error(t('git.checkoutFailed'), { description: e instanceof Error ? e.message : String(e) });
    }
  };

  // Commit ops mirror the History tab — they always act on the *current*
  // branch (cherry-pick/revert/reset don't checkout first), so we refresh
  // afterwards to reflect the new HEAD.
  const runOp = async (
    label: string,
    path: 'projectGit.cherryPick' | 'projectGit.revert' | 'projectGit.reset',
    body: object,
  ) => {
    try {
      const r = await apiCall<GitRunResult>(path, { projectId, repoPath, ...body });
      if (r.ok) toast.success(t('git.operationOk', { operation: label }));
      else
        toast.error(t('git.operationIssues', { operation: label }), {
          description: r.stderr.trim().slice(0, 300) || r.stdout.trim().slice(0, 300),
        });
      await reload();
      // A conflict here must light up the Git tool window's banner/Conflicts tab.
      requestGitReload();
    } catch (e) {
      toast.error(t('git.operationFailed', { operation: label }), { description: e instanceof Error ? e.message : String(e) });
    }
  };

  const revert = async (c: Commit) => {
    const ok = await confirm({
      title: t('git.history.revertTitle', { sha: c.shortSha }),
      description: t('git.history.revertBody', { subject: c.subject.slice(0, 80) }),
      confirmLabel: t('git.history.revert'),
    });
    if (ok) await runOp('Revert', 'projectGit.revert', { commit: c.sha });
  };

  const reset = async (c: Commit, mode: 'soft' | 'mixed' | 'hard') => {
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
          description: mode === 'soft' ? t('git.history.resetSoft') : t('git.history.resetMixed'),
          confirmLabel: `Reset --${mode}`,
        });
    if (ok) await runOp('Reset', 'projectGit.reset', { target: c.sha, mode });
  };

  return (
    <div className="h-full flex flex-col min-h-0 bg-background">
      <div className="shrink-0 px-3 py-1.5 border-b flex items-center gap-2">
        <GitBranch className="h-3.5 w-3.5 text-primary shrink-0" />
        <span className="text-[12px] font-medium truncate">{branch}</span>
        {isCurrent ? (
          <span className="text-[10px] text-emerald-400 shrink-0">{t('git.current')}</span>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-[11px] gap-1.5 text-muted-foreground hover:text-foreground"
            onClick={() => void switchTo()}
            title={isRemote ? t('git.checkoutRemoteTitle', { branch }) : t('git.switchBranchTitle', { branch })}
          >
            <ArrowRightLeft className="h-3 w-3" />
            {isRemote ? t('git.checkout') : t('git.switch')}
          </Button>
        )}
        <div className="ml-auto flex items-center gap-1.5">
          <span className="text-[10px] tabular-nums text-muted-foreground">
            {t('git.history.loaded', { count: commits.length })}
          </span>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={() => void reload()}
            title={t('git.refresh')}
          >
            {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
          </Button>
        </div>
      </div>

      {error && <div className="px-3 py-1 text-[11px] text-destructive shrink-0">{error}</div>}

      <PanelGroup direction="horizontal" autoSaveId="mcp-git-log-split" className="flex-1 min-h-0">
        <Panel defaultSize={56} minSize={30}>
          <div
            ref={scrollRef}
            className="h-full overflow-y-auto"
            onScroll={(event) => {
              scrollOffsetRef.current = event.currentTarget.scrollTop;
            }}
          >
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
                        selected={selected === c.sha}
                        disabled={opInProgress}
                        onSelect={() => setSelected(c.sha)}
                        onCherryPick={() => void runOp('Cherry-pick', 'projectGit.cherryPick', { commits: [c.sha] })}
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
        </Panel>
        <PanelResizeHandle className="w-px bg-border hover:bg-primary/40 transition-colors" />
        <Panel defaultSize={44} minSize={25}>
          <CommitDetailPanel projectId={projectId} repoPath={repoPath} sha={selected} />
        </Panel>
      </PanelGroup>
    </div>
  );
}
