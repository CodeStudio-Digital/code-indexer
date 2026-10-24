/**
 * Per-file Git actions for the Explorer context menu's "Git ▸" submenu —
 * shown only when the project is a git repo. A pure builder (no hooks, like
 * `tree-context`'s other items): the `onSelect` closures read the workspace
 * store via `getState()` and hit the same `projectGit.*` verbs + `openDiff`
 * the footer Git tool window uses, so behaviour stays defined once.
 *
 * Paths: every `projectGit` verb runs git at the project `root_path` and takes
 * the path verbatim, so `entry.path` (project-relative posix) is exactly right
 * — no conversion.
 */
import { GitCompare, Minus, Plus, Undo2 } from 'lucide-react';
import i18n from '../../../i18n/index.js';
import { apiCall } from '../../../lib/api-client.js';
import type { ContextMenuItem } from '../../../components/ui/context-menu.js';
import { confirm, toast } from '../../../components/ui/prompt-dialog.js';
import type { TreeEntry } from '../../../state/file-tree.js';
import { useWorkspaceStore } from '../../../state/workspace.js';
import { requestGitReload } from '../editor/conflict-registry.js';

const errDesc = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function buildFileGitActions(
  entry: TreeEntry,
  projectId: number,
  onMutated: () => void,
): ContextMenuItem[] {
  const path = entry.path;
  const name = entry.name;

  const showDiff = async () => {
    try {
      const { patch } = await apiCall<{ patch: string }>('projectGit.diff', { projectId, path });
      if (!patch.trim()) {
        toast.info(i18n.t('workspace:git.noChanges'), { description: path });
        return;
      }
      useWorkspaceStore.getState().openDiff({
        kind: 'diff',
        projectId,
        path: `gitdiff:${path}`,
        title: i18n.t('workspace:git.diffTitle', { file: name }),
        patch,
        source: 'git-unstaged',
      });
    } catch (e) {
      toast.error(i18n.t('workspace:git.diffFailed'), { description: errDesc(e) });
    }
  };

  const afterMutate = () => {
    onMutated();
    requestGitReload();
  };

  const stage = async () => {
    try {
      await apiCall<{ ok: true }>('projectGit.stage', { projectId, paths: [path] });
      afterMutate();
    } catch (e) {
      toast.error(i18n.t('workspace:git.stageFailed'), { description: errDesc(e) });
    }
  };

  const unstage = async () => {
    try {
      await apiCall<{ ok: true }>('projectGit.unstage', { projectId, paths: [path] });
      afterMutate();
    } catch (e) {
      toast.error(i18n.t('workspace:git.unstageFailed'), { description: errDesc(e) });
    }
  };

  const revert = async () => {
    const ok = await confirm({
      title: i18n.t('workspace:git.revertConfirmTitle'),
      description: i18n.t('workspace:git.revertConfirmBody', { path }),
      confirmLabel: i18n.t('workspace:git.revert'),
      tone: 'destructive',
    });
    if (!ok) return;
    try {
      await apiCall<{ ok: true }>('projectGit.discard', { projectId, paths: [path] });
      afterMutate();
      toast.success(i18n.t('workspace:git.reverted'), { description: path });
    } catch (e) {
      toast.error(i18n.t('workspace:git.revertFailed'), { description: errDesc(e) });
    }
  };

  return [
    { id: 'git-diff', label: i18n.t('workspace:git.showDiff'), icon: GitCompare, onSelect: () => void showDiff() },
    { id: 'git-stage', label: i18n.t('workspace:git.stage'), icon: Plus, onSelect: () => void stage() },
    { id: 'git-unstage', label: i18n.t('workspace:git.unstage'), icon: Minus, onSelect: () => void unstage() },
    {
      id: 'git-revert',
      label: i18n.t('workspace:git.revert'),
      icon: Undo2,
      destructive: true,
      separatorBefore: true,
      onSelect: () => void revert(),
    },
  ];
}
