/**
 * Every branch operation, in one place — shared by the Git tool-window
 * Branches tab and the status-bar branch popover so the IntelliJ action set
 * (checkout / new-from / merge / rebase / pull / compare / rename / delete /
 * push) is defined ONCE. Each op wraps the apiCall + confirm/toast, refreshes
 * the caller (`onMutated`), and pings the conflict registry so a merge/rebase
 * conflict lights the Git window's banner + Conflicts tab.
 */
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { apiCall } from '../../../../../lib/api-client.js';
import { useWorkspaceStore } from '../../../../../state/workspace.js';
import { confirm, prompt, toast } from '../../../../../components/ui/prompt-dialog.js';
import { requestGitReload } from '../../../editor/conflict-registry.js';
import type { GitBranch } from '@mcp/api-bus';
import { checkoutBranch } from './branch-actions.js';

interface GitRunResult { ok: boolean; stdout: string; stderr: string }

export interface BranchActions {
  onOpenLog: (b: GitBranch) => void;
  onSwitch: (b: GitBranch) => void;
  onNewBranchFrom: (b: GitBranch) => void;
  onRename: (b: GitBranch) => void;
  onMerge: (b: GitBranch) => void;
  onRebase: (b: GitBranch) => void;
  onCompare: (b: GitBranch) => void;
  onShowDiff: (b: GitBranch) => void;
  onPull: (b: GitBranch, mode: 'merge' | 'rebase') => void;
  /** Bring a local branch up to date with its upstream (the "famous pull"). */
  onUpdate: (b: GitBranch) => void;
  onPush: (b: GitBranch) => void;
  onDelete: (b: GitBranch) => void;
}

interface UseBranchOps {
  projectId: number;
  /** Selected git root (submodule / nested repo); undefined = main repo. */
  repoPath?: string;
  /** Snapshot of the branch list — used to resolve the current branch. */
  getBranches: () => GitBranch[];
  /** Refresh the caller (reload its list + bubble to the parent). */
  onMutated: () => void | Promise<void>;
  /** Optional: dismiss the surface (footer popover) after a checkout. */
  onClose?: () => void;
}

/** stderr/stdout → a short toast description. */
const tail = (r: GitRunResult) => r.stderr.trim().slice(0, 300) || r.stdout.trim().slice(0, 300);
const remoteOf = (b: GitBranch) => b.name.split('/')[0] || 'origin';

export function useBranchOps({ projectId, repoPath, getBranches, onMutated, onClose }: UseBranchOps): BranchActions {
  const { t } = useTranslation('workspace');
  const openGitLog = useWorkspaceStore((s) => s.openGitLog);
  const openDiff = useWorkspaceStore((s) => s.openDiff);

  return useMemo<BranchActions>(() => {
    const after = async () => { await onMutated(); };
    const currentName = () => getBranches().find((x) => x.isCurrent)?.name ?? null;

    const openLog = (b: GitBranch) =>
      openGitLog({ kind: 'git-log', projectId, repoPath, path: `gitlog:${repoPath ?? ''}:${b.name}`, title: `Log: ${b.name}`, branch: b.name, isRemote: b.isRemote });

    const switchTo = async (b: GitBranch) => {
      if (b.isCurrent) return;
      try {
        const name = await checkoutBranch(projectId, b.name, b.isRemote, repoPath);
        toast.success(t('git.branchSwitched', { branch: name }));
        await after();
        onClose?.();
      } catch (e) {
        toast.error(t('git.checkoutFailed'), { description: e instanceof Error ? e.message : String(e) });
      }
    };

    const newBranchFrom = async (b: GitBranch) => {
      const name = await prompt({ title: t('git.branch.newFromTitle', { branch: b.name }), description: t('git.branch.newFromBody'), placeholder: 'feature/cool-thing' });
      if (!name?.trim()) return;
      try {
        await apiCall('projectGit.branchCreate', { projectId, repoPath, name: name.trim(), from: b.name, checkout: true });
        toast.success(t('git.branch.createdSwitched', { branch: name.trim() }));
        await after();
        onClose?.();
      } catch (e) {
        toast.error(t('git.branch.createFailed'), { description: e instanceof Error ? e.message : String(e) });
      }
    };

    const rename = async (b: GitBranch) => {
      const newName = await prompt({ title: t('git.branch.renameTitle', { branch: b.name }), description: t('git.branch.renameBody'), placeholder: b.name, defaultValue: b.name });
      if (!newName?.trim() || newName.trim() === b.name) return;
      try {
        await apiCall('projectGit.branchRename', { projectId, repoPath, oldName: b.name, newName: newName.trim() });
        toast.success(t('git.branch.renamed', { branch: newName.trim() }));
        await after();
      } catch (e) {
        toast.error(t('git.branch.renameFailed'), { description: e instanceof Error ? e.message : String(e) });
      }
    };

    const push = async (b: GitBranch) => {
      try {
        const remote = b.upstream ? b.upstream.split('/')[0] : 'origin';
        const r = await apiCall<GitRunResult>('projectGit.push', { projectId, repoPath, remote, branch: b.name, setUpstream: !b.upstream });
        r.ok ? toast.success(t('git.branch.pushed', { branch: b.name })) : toast.error(t('git.branch.pushIssues'), { description: tail(r) });
        await after();
      } catch (e) {
        toast.error(t('git.pushFailed'), { description: e instanceof Error ? e.message : String(e) });
      }
    };

    const remove = async (b: GitBranch) => {
      if (b.isCurrent) { toast.error(t('git.branch.deleteCurrent'), { description: t('git.branch.deleteCurrentBody') }); return; }
      if (b.isRemote) { toast.message(t('git.branch.remoteReadOnly'), { description: t('git.branch.remoteReadOnlyBody') }); return; }
      const ok = await confirm({ title: t('git.branch.deleteTitle', { branch: b.name }), description: b.ahead > 0 ? t('git.branch.deleteAheadBody', { count: b.ahead }) : t('git.branch.deleteBody'), confirmLabel: t('git.branchMenu.delete'), tone: 'destructive' });
      if (!ok) return;
      try {
        await apiCall('projectGit.branchDelete', { projectId, repoPath, name: b.name });
        toast.success(t('git.branch.deleted', { branch: b.name }));
        await after();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (/not fully merged|not yet merged/i.test(msg)) {
          const force = (await prompt({
            title: t('git.branch.forceDeleteTitle', { branch: b.name }),
            description: t('git.branch.forceDeleteBody', { token: `DELETE ${b.name}` }),
            placeholder: `DELETE ${b.name}`,
            confirmLabel: t('git.branch.forceDelete'),
            validate: (value) => value === `DELETE ${b.name}` ? null : t('git.branch.forceDeleteValidation', { token: `DELETE ${b.name}` }),
          })) === `DELETE ${b.name}`;
          if (!force) return;
          try { await apiCall('projectGit.branchDelete', { projectId, repoPath, name: b.name, force: true }); toast.success(t('git.branch.forceDeleted', { branch: b.name })); await after(); }
          catch (e2) { toast.error(t('git.branch.deleteFailed'), { description: e2 instanceof Error ? e2.message : String(e2) }); }
        } else { toast.error(t('git.branch.deleteFailed'), { description: msg }); }
      }
    };

    const merge = async (b: GitBranch) => {
      const current = currentName();
      if (!current) { toast.error(t('git.branch.mergeDetached')); return; }
      const ok = await confirm({ title: t('git.branch.mergeTitle', { branch: b.name, current }), description: t('git.branch.mergeBody'), confirmLabel: t('git.branch.merge') });
      if (!ok) return;
      try {
        const r = await apiCall<GitRunResult>('projectGit.merge', { projectId, repoPath, branch: b.name });
        r.ok ? toast.success(t('git.branch.merged', { branch: b.name, current })) : toast.error(t('git.branch.mergeIssues'), { description: tail(r) });
        await after();
        requestGitReload();
      } catch (e) { toast.error(t('git.branch.mergeFailed'), { description: e instanceof Error ? e.message : String(e) }); }
    };

    const rebase = async (b: GitBranch) => {
      const current = currentName();
      if (!current) { toast.error(t('git.branch.rebaseDetached')); return; }
      const ok = await confirm({ title: t('git.branch.rebaseTitle', { current, branch: b.name }), description: t('git.branch.rebaseBody'), confirmLabel: t('git.branch.rebase') });
      if (!ok) return;
      try {
        const r = await apiCall<GitRunResult>('projectGit.rebase', { projectId, repoPath, onto: b.name });
        r.ok ? toast.success(t('git.branch.rebased', { current, branch: b.name })) : toast.error(t('git.branch.rebaseStopped'), { description: tail(r) });
        await after();
        requestGitReload();
      } catch (e) { toast.error(t('git.branch.rebaseFailed'), { description: e instanceof Error ? e.message : String(e) }); }
    };

    const pull = async (b: GitBranch, mode: 'merge' | 'rebase') => {
      const current = currentName();
      if (!current) { toast.error(t('git.branch.pullDetached')); return; }
      try {
        const fetched = await apiCall<GitRunResult>('projectGit.fetch', { projectId, repoPath, remote: remoteOf(b) });
        if (!fetched.ok) { toast.error(t('git.branch.fetchFailed'), { description: tail(fetched) }); return; }
        const r = mode === 'rebase'
          ? await apiCall<GitRunResult>('projectGit.rebase', { projectId, repoPath, onto: b.name })
          : await apiCall<GitRunResult>('projectGit.merge', { projectId, repoPath, branch: b.name });
        r.ok ? toast.success(t('git.branch.pulled', { branch: b.name, current })) : toast.error(t('git.branch.pullStopped'), { description: tail(r) });
        await after();
        requestGitReload();
      } catch (e) { toast.error(t('git.branch.pullFailed'), { description: e instanceof Error ? e.message : String(e) }); }
    };

    const update = async (b: GitBranch) => {
      try {
        // Current branch → the famous `git pull` (rebase, like Update Project);
        // a non-current branch can't be pulled into, so fast-forward its ref.
        const r = b.isCurrent
          ? await apiCall<GitRunResult>('projectGit.pull', { projectId, repoPath, rebase: true })
          : await apiCall<GitRunResult>('projectGit.updateBranch', { projectId, repoPath, branch: b.name });
        r.ok ? toast.success(t('git.branch.updated', { branch: b.name })) : toast.error(t('git.branch.updateIssues'), { description: tail(r) });
        await after();
        requestGitReload();
      } catch (e) { toast.error(t('git.branch.updateFailed'), { description: e instanceof Error ? e.message : String(e) }); }
    };

    const compare = async (b: GitBranch, worktree: boolean) => {
      try {
        const { patch } = await apiCall<{ patch: string }>('projectGit.branchDiff', { projectId, repoPath, branch: b.name, worktree });
        if (!patch.trim()) { toast.message(t('git.branch.noDifferences'), { description: worktree ? t('git.branch.worktreeMatches', { branch: b.name }) : t('git.branch.matchesCurrent', { branch: b.name }) }); return; }
        openDiff({ kind: 'diff', projectId, path: `branchdiff:${worktree ? 'wt' : 'cmp'}:${b.name}`, title: worktree ? `Diff vs ${b.name}` : `Compare ${b.name}`, patch, source: 'git-unstaged' });
        onClose?.();
      } catch (e) { toast.error(t('git.branch.compareFailed'), { description: e instanceof Error ? e.message : String(e) }); }
    };

    return {
      onOpenLog: openLog,
      onSwitch: (b) => void switchTo(b),
      onNewBranchFrom: (b) => void newBranchFrom(b),
      onRename: (b) => void rename(b),
      onMerge: (b) => void merge(b),
      onRebase: (b) => void rebase(b),
      onCompare: (b) => void compare(b, false),
      onShowDiff: (b) => void compare(b, true),
      onPull: (b, mode) => void pull(b, mode),
      onUpdate: (b) => void update(b),
      onPush: (b) => void push(b),
      onDelete: (b) => void remove(b),
    };
  }, [projectId, repoPath, getBranches, onMutated, onClose, openGitLog, openDiff, t]);
}
