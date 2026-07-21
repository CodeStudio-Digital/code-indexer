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

const STATUS_PAGE_SIZE = 1_000;
const MUTATION_BATCH_SIZE = 2_000; // Matches the server-side safety bound.
const GIT_REV_RELOAD_DEBOUNCE_MS = 150;

interface GitReloadRun {
  silent: boolean;
  isCurrent: () => boolean;
}

interface GitReloadCoordinator {
  setRunner: (runner: (run: GitReloadRun) => Promise<void>) => void;
  request: (options?: { silent?: boolean; debounce?: boolean }) => Promise<void>;
  invalidate: () => void;
}

/**
 * Serializes status refreshes. Watcher bumps are debounced, while explicit
 * refreshes bypass the timer. A request received during a run supersedes that
 * result and is folded into one final run after the current one settles.
 */
export function createGitReloadCoordinator(
  debounceMs = GIT_REV_RELOAD_DEBOUNCE_MS,
): GitReloadCoordinator {
  let runner: (run: GitReloadRun) => Promise<void> = async () => {};
  let revision = 0;
  let pendingRevision: number | null = null;
  let pendingSilent = true;
  let pendingImmediate = false;
  let inFlight = false;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let waiters: Array<{ revision: number; resolve: () => void; reject: (error: unknown) => void }> = [];

  const clearDebounce = () => {
    if (debounceTimer !== null) clearTimeout(debounceTimer);
    debounceTimer = null;
  };
  const settleThrough = (completedRevision: number, error?: unknown) => {
    const settled = waiters.filter((waiter) => waiter.revision <= completedRevision);
    waiters = waiters.filter((waiter) => waiter.revision > completedRevision);
    for (const waiter of settled) {
      if (error === undefined) waiter.resolve();
      else waiter.reject(error);
    }
  };

  const drain = async (): Promise<void> => {
    if (inFlight || debounceTimer !== null || pendingRevision === null) return;
    const runRevision = pendingRevision;
    const silent = pendingSilent;
    pendingRevision = null;
    pendingSilent = true;
    pendingImmediate = false;
    inFlight = true;
    try {
      await runner({ silent, isCurrent: () => runRevision === revision });
      if (runRevision === revision) settleThrough(runRevision);
    } catch (error) {
      if (runRevision === revision) settleThrough(runRevision, error);
    } finally {
      inFlight = false;
      if (pendingRevision !== null && debounceTimer === null) void drain();
    }
  };

  return {
    setRunner(nextRunner) {
      runner = nextRunner;
    },
    request(options = {}) {
      const hadPending = pendingRevision !== null;
      const requestRevision = ++revision;
      pendingRevision = requestRevision;
      pendingSilent = hadPending ? pendingSilent && (options.silent ?? false) : (options.silent ?? false);
      pendingImmediate = hadPending ? pendingImmediate || !options.debounce : !options.debounce;

      const completion = new Promise<void>((resolve, reject) => {
        waiters.push({ revision: requestRevision, resolve, reject });
      });
      if (pendingImmediate) {
        clearDebounce();
        void drain();
      } else {
        clearDebounce();
        debounceTimer = setTimeout(() => {
          debounceTimer = null;
          void drain();
        }, debounceMs);
      }
      return completion;
    },
    invalidate() {
      revision += 1;
      pendingRevision = null;
      pendingSilent = true;
      pendingImmediate = false;
      clearDebounce();
      settleThrough(revision);
    },
  };
}

/**
 * The API keeps an immutable snapshot, but UI pagination makes group counts and
 * bulk selection misleading. Fetch the remaining snapshot slices in parallel;
 * the virtualized view will only mount the visible rows.
 */
async function loadCompleteStatus(projectId: number, repoPath?: string): Promise<GitWorkspaceSnapshot> {
  const first = await apiCall<GitWorkspaceSnapshot>('projectGit.statusPage', {
    projectId,
    repoPath,
    pageSize: STATUS_PAGE_SIZE,
  });
  if (!first.snapshotId || !first.nextCursor) return first;

  const offsets: number[] = [];
  for (let offset = first.files.length; offset < first.counts.total; offset += STATUS_PAGE_SIZE) {
    offsets.push(offset);
  }
  const remaining = await Promise.all(offsets.map((offset) => apiCall<GitWorkspaceSnapshot>('projectGit.statusPage', {
    projectId,
    repoPath,
    snapshotId: first.snapshotId!,
    cursor: String(offset),
    pageSize: STATUS_PAGE_SIZE,
  })));
  return {
    ...first,
    files: [first, ...remaining].flatMap((page) => page.files),
    nextCursor: null,
  };
}

async function mutatePaths(
  method: 'projectGit.stage' | 'projectGit.unstage' | 'projectGit.discard',
  projectId: number,
  repoPath: string | undefined,
  paths: string[],
): Promise<void> {
  for (let offset = 0; offset < paths.length; offset += MUTATION_BATCH_SIZE) {
    await apiCall(method, { projectId, repoPath, paths: paths.slice(offset, offset + MUTATION_BATCH_SIZE) });
  }
}

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
  groups: { staged: GitStatusFile[]; unstaged: GitStatusFile[]; untracked: GitStatusFile[] };
  reload: (silent?: boolean) => Promise<void>;
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
  const openDiff = useWorkspaceStore((s) => s.openDiff);
  const staleWhileHidden = useRef(false);
  const observedGitRevision = useRef<{ context: string; revision: number } | null>(null);
  const reloadCoordinatorRef = useRef<GitReloadCoordinator | null>(null);
  const reloadCoordinator = reloadCoordinatorRef.current
    ?? (reloadCoordinatorRef.current = createGitReloadCoordinator());

  useEffect(() => {
    staleWhileHidden.current = false;
    setStatus(null);
    setMergeState(null);
    setError(null);
    setLoading(true);
    setStatusCounts(null);
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
  reloadCoordinator.setRunner(async ({ silent, isCurrent }) => {
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
          ? loadCompleteStatus(projectId, repoPath)
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
      if (!isCurrent()) return;
      setStatus(s);
      if ('counts' in s) {
        setStatusCounts(s.counts);
      } else {
        setStatusCounts(null);
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
      if (isCurrent()) setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (isCurrent()) setLoading(false);
    }
  });

  const reload = useCallback((silent = false): Promise<void> => {
    if (!active || !ready) {
      staleWhileHidden.current = true;
      return Promise.resolve();
    }
    if (!silent) setLoading(true);
    return reloadCoordinator.request({ silent });
  }, [active, ready, reloadCoordinator]);

  useEffect(() => {
    if (active && ready) void reload(staleWhileHidden.current);
    else reloadCoordinator.invalidate();
    return () => reloadCoordinator.invalidate();
  }, [active, ready, projectId, repoPath, repoPrefix, tab, reload, reloadCoordinator]);

  // The git-meta watcher bumps this on any .git change (incl. external
  // checkout) — reload status + mergeState so the window never goes stale.
  const gitRev = useGitRevision((s) => s.revByProject[projectId] ?? 0);
  const reloadContext = `${projectId}\0${repoPath ?? ''}\0${repoPrefix ?? ''}\0${tab}`;
  useEffect(() => {
    const observed = observedGitRevision.current;
    observedGitRevision.current = { context: reloadContext, revision: gitRev };
    // The context-load effect already covers the first revision observed for a
    // project/repo/tab. Only subsequent watcher bumps need a background refresh.
    if (!observed || observed.context !== reloadContext || observed.revision === gitRev || !gitRev) return;
    if (!active || !ready) {
      staleWhileHidden.current = true;
      reloadCoordinator.invalidate();
      return;
    }
    void reloadCoordinator.request({ silent: true, debounce: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- active/ready changes are handled by the context-load effect
  }, [gitRev, reloadContext, reloadCoordinator]);

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
      await mutatePaths('projectGit.stage', projectId, repoPath, paths);
      await reload();
    } catch (err) {
      toast.error(t('git.stageFailed'), { description: err instanceof Error ? err.message : String(err) });
    }
  };
  const onUnstage = async (paths: string[]) => {
    try {
      await mutatePaths('projectGit.unstage', projectId, repoPath, paths);
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
      await mutatePaths('projectGit.discard', projectId, repoPath, paths);
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
    statusCounts, groups, reload, showDiff, onStage, onUnstage, onDiscard,
  };
}
