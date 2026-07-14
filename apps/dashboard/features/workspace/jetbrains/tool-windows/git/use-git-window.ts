/**
 * Estado + lógica do Git tool window (extraído do GitWindow — W4 decompose).
 * Carrega status + mergeState, agrupa arquivos por stage, e expõe as ações
 * (stage/unstage/discard/showDiff/reload). O shell (GitWindow.tsx) só consome.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { useTranslation } from 'react-i18next';
import type { GitMergeState, GitStatus, GitStatusFile, GitWorkspaceSnapshot } from '@mcp/api-bus';
import { apiCall } from '../../../../../lib/api-client.js';
import { startRouteSpan } from '../../../../../lib/perf/route-startup-metrics.js';
import { useWorkspaceStore } from '../../../../../state/workspace.js';
import { useGitRevision } from '../../../../../state/git-revision.js';
import { confirm, prompt, toast } from '../../../../../components/ui/prompt-dialog.js';
import { setConflicts, clearConflicts, onGitReloadRequest } from '../../../editor/conflict-registry.js';
import type { GitTab } from './GitTabNav.js';

export type { GitStatus, GitStatusFile } from '@mcp/api-bus';

interface OpenSections {
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
}

export interface GitWindowModel {
  status: GitStatus | null;
  loading: boolean;
  error: string | null;
  openSections: OpenSections;
  setOpenSections: Dispatch<SetStateAction<OpenSections>>;
  tab: GitTab;
  setTab: Dispatch<SetStateAction<GitTab>>;
  mergeState: GitMergeState | null;
  statusCounts: GitWorkspaceSnapshot['counts'] | null;
  hasMoreStatus: boolean;
  loadingMoreStatus: boolean;
  groups: { staged: GitStatusFile[]; unstaged: GitStatusFile[]; untracked: GitStatusFile[] };
  reload: (silent?: boolean) => Promise<void>;
  loadMoreStatus: () => Promise<void>;
  showDiff: (file: GitStatusFile) => Promise<void>;
  onStage: (paths: string[]) => Promise<void>;
  onUnstage: (paths: string[]) => Promise<void>;
  onDiscard: (paths: string[]) => Promise<void>;
}

// Auto-switch memory per (project, repo) — GitWindow unmounts on every Git↔Files
// tab toggle, so a useRef would reset and re-yank the user to the Conflicts tab
// on every return mid-merge. Module scope survives remounts. Keyed by repo too
// so switching the active repo can't be mistaken for a real merge transition.
const autoSwitchedKind = new Map<string, GitMergeState['kind']>();

export function useGitWindow(
  projectId: number,
  active: boolean,
  repoPath?: string,
  /** Active repo's project-relative prefix ('' = main) — used to rebase
   *  repoRoot-relative conflict paths to project-relative for the editor. */
  repoPrefix?: string,
  /** False until listRepos resolves — gates the first fetch so the window never
   *  briefly issues the no-repoPath (project-wide AGGREGATE) status before the
   *  real repoPath (main / selection) is known. */
  ready = true,
): GitWindowModel {
  const { t } = useTranslation('workspace');
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [openSections, setOpenSections] = useState<OpenSections>({ staged: true, unstaged: true, untracked: false });
  const [tab, setTab] = useState<GitTab>('changes');
  const [mergeState, setMergeState] = useState<GitMergeState | null>(null);
  const [statusCounts, setStatusCounts] = useState<GitWorkspaceSnapshot['counts'] | null>(null);
  const [statusSnapshotId, setStatusSnapshotId] = useState<string | null>(null);
  const [statusCursor, setStatusCursor] = useState<string | null>(null);
  const [loadingMoreStatus, setLoadingMoreStatus] = useState(false);
  const openDiff = useWorkspaceStore((s) => s.openDiff);
  const staleWhileHidden = useRef(false);
  const reloadRequest = useRef(0);

  useEffect(() => {
    reloadRequest.current += 1;
    staleWhileHidden.current = false;
    setStatus(null);
    setMergeState(null);
    setError(null);
    setLoading(true);
    setStatusCounts(null);
    setStatusSnapshotId(null);
    setStatusCursor(null);
    setLoadingMoreStatus(false);
  }, [projectId, repoPath]);

  const showDiff = useCallback(
    async (file: GitStatusFile) => {
      try {
        const r = await apiCall<{ patch: string }>('projectGit.diff', {
          projectId,
          repoPath,
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
    [projectId, repoPath, openDiff, t],
  );

  // `silent` skips the loading flag (no toolbar spinner) — used for background
  // refreshes driven by the git-meta watcher (a commit/fetch shouldn't blink the
  // spinner); the initial load and explicit user refresh stay non-silent.
  const reload = useCallback(async (silent = false) => {
    if (!active) {
      staleWhileHidden.current = true;
      return;
    }
    // Hold the initial fetch until repos are known so repoPath is settled (else
    // the first status would be the project-wide aggregate). Stays in loading.
    if (!ready) return;
    const requestId = ++reloadRequest.current;
    const includeFiles = tab === 'changes';
    if (!silent) setLoading(true);
    const finishStatusSpan = startRouteSpan('GitWindow:status', {
      projectId,
      tab: 'git',
      detail: includeFiles ? 'full' : 'summary',
    });
    const finishMergeSpan = startRouteSpan('GitWindow:mergeState', { projectId, tab: 'git' });
    try {
      const [s, ms] = await Promise.all([
        (includeFiles
          ? apiCall<GitWorkspaceSnapshot>('projectGit.statusPage', { projectId, repoPath, pageSize: 250 })
          : apiCall<GitStatus>('projectGit.status', { projectId, repoPath, includeFiles: false }))
          .then((value) => {
            finishStatusSpan({ status: 'ok' });
            return value;
          })
          .catch((err) => {
            finishStatusSpan({ status: 'error', error: err instanceof Error ? err.message : String(err) });
            throw err;
          }),
        apiCall<GitMergeState>('projectGit.mergeState', { projectId, repoPath })
          .then((value) => {
            finishMergeSpan({ status: 'ok' });
            return value;
          })
          .catch((err) => {
            finishMergeSpan({ status: 'error', error: err instanceof Error ? err.message : String(err) });
            throw err;
          }),
      ]);
      if (requestId !== reloadRequest.current) return;
      setStatus(s);
      if ('counts' in s) {
        setStatusCounts(s.counts);
        setStatusSnapshotId(s.snapshotId);
        setStatusCursor(s.nextCursor);
      } else {
        setStatusCounts(null);
        setStatusSnapshotId(null);
        setStatusCursor(null);
      }
      setMergeState(ms);
      staleWhileHidden.current = false;
      // Feed the editor's conflict registry (project-relative paths) so open
      // files light up inline. mergeState paths are repoRoot-relative, so for a
      // submodule we prefix them with the active repo's project-relative prefix.
      const prefix = repoPrefix ?? '';
      if (ms.kind) {
        const rebased = prefix ? ms.conflictedFiles.map((f) => `${prefix}/${f}`) : ms.conflictedFiles;
        setConflicts(projectId, prefix, rebased);
      } else {
        clearConflicts(projectId, prefix);
      }
      setError(null);
    } catch (err) {
      if (requestId === reloadRequest.current) setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (requestId === reloadRequest.current) setLoading(false);
    }
  }, [active, ready, projectId, repoPath, repoPrefix, tab]);

  const loadMoreStatus = useCallback(async () => {
    if (!active || !statusSnapshotId || !statusCursor || loadingMoreStatus) return;
    const requestId = reloadRequest.current;
    setLoadingMoreStatus(true);
    try {
      const page = await apiCall<GitWorkspaceSnapshot>('projectGit.statusPage', {
        projectId,
        repoPath,
        snapshotId: statusSnapshotId,
        cursor: statusCursor,
        pageSize: 250,
      });
      if (requestId !== reloadRequest.current) return;
      setStatus((current) => current ? { ...current, files: [...(current.files ?? []), ...page.files] } : page);
      setStatusCursor(page.nextCursor);
      setStatusCounts(page.counts);
    } catch (cause) {
      if (requestId !== reloadRequest.current) return;
      const err = cause as Error & { status?: number };
      if (err.status === 410) await reload(true);
      else setError(err.message);
    } finally {
      if (requestId === reloadRequest.current) setLoadingMoreStatus(false);
    }
  }, [active, loadingMoreStatus, projectId, reload, repoPath, statusCursor, statusSnapshotId]);

  useEffect(() => {
    if (active) void reload(staleWhileHidden.current);
  }, [active, reload]);

  // The git-meta watcher bumps this on any .git change (incl. external
  // checkout) — reload status + mergeState so the window never goes stale.
  const gitRev = useGitRevision((s) => s.revByProject[projectId] ?? 0);
  useEffect(() => {
    if (gitRev) void reload(true); // hidden windows only mark stale; visible windows refresh silently
    // eslint-disable-next-line react-hooks/exhaustive-deps -- bump on revision only
  }, [gitRev]);

  // Auto-surface the Conflicts tab the moment a sequencer op flips into a
  // conflicted state; fall back to Changes once it clears. Keyed per project in
  // module scope so a tab-toggle remount mid-merge doesn't re-force the switch.
  useEffect(() => {
    const key = `${projectId}:${repoPath ?? ''}`;
    const kind = mergeState?.kind ?? null;
    const prev = autoSwitchedKind.get(key) ?? null;
    if (kind && !prev) setTab('conflicts');
    else if (!kind && prev) setTab((cur) => (cur === 'conflicts' ? 'changes' : cur));
    autoSwitchedKind.set(key, kind);
  }, [mergeState?.kind, projectId, repoPath, setTab]);

  // NOTE: deliberately NO force-clear of the conflict registry on unmount — the
  // Git window unmounts on every Files↔Git tab toggle, and clearing here would
  // kill the inline conflict decorations on an open file mid-merge. The registry
  // is kept current by reload() (setConflicts / clearConflicts(projectId)); the
  // inline path is also projectId-scoped and self-gates on actual buffer markers.

  // The 3-pane merge editor (in the editor pane) pings us after resolving.
  useEffect(() => onGitReloadRequest(() => void reload()), [reload]);

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
      await apiCall('projectGit.stage', { projectId, repoPath, paths });
      await reload();
    } catch (err) {
      toast.error(t('git.stageFailed'), { description: err instanceof Error ? err.message : String(err) });
    }
  };
  const onUnstage = async (paths: string[]) => {
    try {
      await apiCall('projectGit.unstage', { projectId, repoPath, paths });
      await reload();
    } catch (err) {
      toast.error(t('git.unstageFailed'), { description: err instanceof Error ? err.message : String(err) });
    }
  };
  const onDiscard = async (paths: string[]) => {
    const outsideCount = (status?.files ?? []).filter((file) => paths.includes(file.path) && file.outsideProject).length;
    const needsTypedConfirmation = paths.length > 1 || outsideCount > 0;
    const ok = needsTypedConfirmation
      ? (await prompt({
          title: t('git.discardTypedTitle', { count: paths.length }),
          description: t('git.discardTypedDescription', { token: 'DISCARD', outside: outsideCount }),
          placeholder: 'DISCARD',
          confirmLabel: t('git.discard'),
        })) === 'DISCARD'
      : await confirm({
          title: t('git.discardTitle_one', { count: paths.length }),
          description: t('git.discardDescription_one', { path: paths[0] }),
          confirmLabel: t('git.discard'),
          tone: 'destructive',
        });
    if (!ok) return;
    try {
      await apiCall('projectGit.discard', { projectId, repoPath, paths });
      await reload();
      toast.success(t('git.discarded'), {
        description: paths.length === 1 ? paths[0] : t('git.filesReverted', { count: paths.length }),
      });
    } catch (err) {
      toast.error(t('git.discardFailed'), { description: err instanceof Error ? err.message : String(err) });
    }
  };

  return {
    status, loading, error, openSections, setOpenSections, tab, setTab, mergeState,
    statusCounts, hasMoreStatus: !!statusCursor, loadingMoreStatus,
    groups, reload, loadMoreStatus, showDiff, onStage, onUnstage, onDiscard,
  };
}
