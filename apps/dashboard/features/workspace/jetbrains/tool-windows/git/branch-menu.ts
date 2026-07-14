/**
 * The IntelliJ-style branch action set, built ONCE and shared by the Git
 * tool-window Branches tab and the status-bar branch popover. Pure: given a
 * branch + the ops, returns the ordered context-menu items.
 */
import {
  ArrowDownToLine,
  ClipboardCopy,
  GitBranchPlus,
  GitCompare,
  GitGraph,
  GitMerge,
  Pencil,
  Trash2,
  Upload,
} from 'lucide-react';
import type { GitBranch } from '@mcp/api-bus';
import type { ContextMenuItem } from '../../../../../components/ui/context-menu.js';
import type { BranchActions } from './use-branch-ops.js';

export function buildBranchActions(
  b: GitBranch,
  actions: BranchActions,
  opts: { opInProgress?: boolean; t?: (key: string, options?: Record<string, unknown>) => string } = {},
): ContextMenuItem[] {
  const op = !!opts.opInProgress; // a sequencer op is mid-flight → gate merge/rebase/pull
  const tr = (key: string, fallback: string, options?: Record<string, unknown>) => opts.t?.(key, options) ?? fallback;
  const items: ContextMenuItem[] = [];

  items.push({
    id: 'switch',
    label: b.isRemote ? tr('git.branchMenu.checkoutLocal', 'Checkout as local branch') : tr('git.checkout', 'Checkout'),
    disabled: b.isCurrent,
    onSelect: () => actions.onSwitch(b),
  });
  items.push({ id: 'open-log', label: tr('git.branchMenu.openLog', 'Open in log'), onSelect: () => actions.onOpenLog(b) });
  items.push({
    id: 'new-from',
    separatorBefore: true,
    label: tr('git.branchMenu.newFrom', 'New branch from here…'),
    icon: GitBranchPlus,
    onSelect: () => actions.onNewBranchFrom(b),
  });

  // Merge / rebase / pull act on the CURRENT branch relative to this one, so
  // they're meaningless on the current branch itself and gated mid-sequencer.
  if (!b.isCurrent) {
    items.push({
      id: 'merge',
      separatorBefore: true,
      label: tr('git.branchMenu.mergeCurrent', `Merge '${b.name}' into current`, { branch: b.name }),
      icon: GitMerge,
      disabled: op,
      onSelect: () => actions.onMerge(b),
    });
    items.push({
      id: 'rebase',
      label: tr('git.branchMenu.rebaseCurrent', `Rebase current onto '${b.name}'`, { branch: b.name }),
      icon: GitGraph,
      disabled: op,
      onSelect: () => actions.onRebase(b),
    });
    if (b.isRemote) {
      items.push({
        id: 'pull',
        label: tr('git.branchMenu.pullCurrent', 'Pull into current'),
        icon: ArrowDownToLine,
        disabled: op,
        submenu: [
          { id: 'pull-merge', label: tr('git.branchMenu.usingMerge', 'Using Merge'), onSelect: () => actions.onPull(b, 'merge') },
          { id: 'pull-rebase', label: tr('git.branchMenu.usingRebase', 'Using Rebase'), onSelect: () => actions.onPull(b, 'rebase') },
        ],
      });
    }
    items.push({
      id: 'compare',
      separatorBefore: true,
      label: tr('git.branchMenu.compareCurrent', 'Compare with current'),
      icon: GitCompare,
      onSelect: () => actions.onCompare(b),
    });
    items.push({
      id: 'show-diff',
      label: tr('git.branchMenu.diffWorktree', 'Show diff with working tree'),
      icon: GitCompare,
      onSelect: () => actions.onShowDiff(b),
    });
  }

  // Update ("the famous pull") — only for a local branch that tracks an
  // upstream. Current branch → `git pull`; non-current → fast-forward fetch.
  if (!b.isRemote && b.upstream) {
    items.push({
      id: 'update',
      separatorBefore: true,
      label: tr('git.branchMenu.update', 'Update'),
      icon: ArrowDownToLine,
      disabled: op,
      onSelect: () => actions.onUpdate(b),
    });
  }

  if (!b.isRemote) {
    items.push({ id: 'rename', separatorBefore: true, label: tr('git.branchMenu.rename', 'Rename…'), icon: Pencil, onSelect: () => actions.onRename(b) });
    items.push({
      id: 'push',
      label: b.upstream ? tr('git.branchMenu.push', 'Push') : tr('git.branchMenu.pushUpstream', 'Push (set upstream)'),
      icon: Upload,
      onSelect: () => actions.onPush(b),
    });
    if (!b.isCurrent) {
      items.push({ id: 'delete', label: tr('git.branchMenu.delete', 'Delete'), icon: Trash2, destructive: true, onSelect: () => actions.onDelete(b) });
    }
  }

  items.push({
    id: 'copy-name',
    separatorBefore: true,
    label: tr('git.branchMenu.copyName', 'Copy name'),
    icon: ClipboardCopy,
    onSelect: () => void navigator.clipboard.writeText(b.name).catch(() => undefined),
  });
  return items;
}
