/**
 * Estado + lógica do Git tool window (extraído do GitWindow — W4 decompose).
 * Carrega status + mergeState, agrupa arquivos por stage, e expõe as ações
 * (stage/unstage/discard/showDiff/reload). O shell (GitWindow.tsx) só consome.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { useTranslation } from 'react-i18next';
import type { GitMergeState } from '@mcp/api-bus';
import { apiCall } from '../../../../../lib/api-client.js';
import { startRouteSpan } from '../../../../../lib/perf/route-startup-metrics.js';
import { useWorkspaceStore } from '../../../../../state/workspace.js';
import { useGitRevision } from '../../../../../state/git-revision.js';
import { confirm, toast } from '../../../../../components/ui/prompt-dialog.js';
import { setConflicts, clearConflicts, onGitReloadRequest } from '../../../editor/conflict-registry.js';
import type { GitTab } from './GitTabNav.js';

export interface GitStatusFile {
  path: string;
  state: string;
  staged: boolean;
}

export interface GitStatus {
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  files?: GitStatusFile[];
  repoRoot: string | null;
  notARepo: boolean;
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
  groups: { staged: GitStatusFile[]; unstaged: GitStatusFile[]; untracked: GitStatusFile[] };
  reload: (silent?: boolean) => Promise<void>;
  showDiff: (file: GitStatusFile) => Promise<void>;
  onStage: (paths: string[]) => Promise<void>;
  onUnstage: (paths: string[]) => Promise<void>;
  onDiscard: (paths: string[]) => Promise<void>;
}

// Auto-switch memory per project, OUTSIDE the hook — GitWindow unmounts on
// every Git↔Files tab toggle, so a useRef would reset and re-yank the user to
// the Conflicts tab on every return mid-merge. Module scope survives remounts.
const autoSwitchedKind = new Map<number, GitMergeState['kind']>();

export function useGitWindow(projectId: number, active: boolean): GitWindowModel {
  const { t } = useTranslation('workspace');
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [openSections, setOpenSections] = useState<OpenSections>({ staged: true, unstaged: true, untracked: false });
  const [tab, setTab] = useState<GitTab>('changes');
  const [mergeState, setMergeState] = useState<GitMergeState | null>(null);
  const openDiff = useWorkspaceStore((s) => s.openDiff);
  const staleWhileHidden = useRef(false);

  useEffect(() => {
    staleWhileHidden.current = false;
    setStatus(null);
    setMergeState(null);
    setError(null);
    setLoading(true);
  }, [projectId]);

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

  // `silent` skips the loading flag (no toolbar spinner) — used for background
  // refreshes driven by the git-meta watcher (a commit/fetch shouldn't blink the
  // spinner); the initial load and explicit user refresh stay non-silent.
  const reload = useCallback(async (silent = false) => {
    if (!active) {
      staleWhileHidden.current = true;
      return;
    }
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
        apiCall<GitStatus>('projectGit.status', { projectId, includeFiles })
          .then((value) => {
            finishStatusSpan({ status: 'ok' });
            return value;
          })
          .catch((err) => {
            finishStatusSpan({ status: 'error', error: err instanceof Error ? err.message : String(err) });
            throw err;
          }),
        apiCall<GitMergeState>('projectGit.mergeState', { projectId })
          .then((value) => {
            finishMergeSpan({ status: 'ok' });
            return value;
          })
          .catch((err) => {
            finishMergeSpan({ status: 'error', error: err instanceof Error ? err.message : String(err) });
            throw err;
          }),
      ]);
      setStatus(s);
      setMergeState(ms);
      staleWhileHidden.current = false;
      // Feed the editor's conflict registry so open files light up inline.
      if (ms.kind) setConflicts(projectId, ms.conflictedFiles);
      else clearConflicts(projectId);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [active, projectId, tab]);

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
    const kind = mergeState?.kind ?? null;
    const prev = autoSwitchedKind.get(projectId) ?? null;
    if (kind && !prev) setTab('conflicts');
    else if (!kind && prev) setTab((cur) => (cur === 'conflicts' ? 'changes' : cur));
    autoSwitchedKind.set(projectId, kind);
  }, [mergeState?.kind, projectId, setTab]);

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
      await apiCall('projectGit.stage', { projectId, paths });
      await reload();
    } catch (err) {
      toast.error(t('git.stageFailed'), { description: err instanceof Error ? err.message : String(err) });
    }
  };
  const onUnstage = async (paths: string[]) => {
    try {
      await apiCall('projectGit.unstage', { projectId, paths });
      await reload();
    } catch (err) {
      toast.error(t('git.unstageFailed'), { description: err instanceof Error ? err.message : String(err) });
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
      toast.error(t('git.discardFailed'), { description: err instanceof Error ? err.message : String(err) });
    }
  };

  return {
    status, loading, error, openSections, setOpenSections, tab, setTab, mergeState,
    groups, reload, showDiff, onStage, onUnstage, onDiscard,
  };
}
