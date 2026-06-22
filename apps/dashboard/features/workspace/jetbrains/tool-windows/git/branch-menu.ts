/**
 * The IntelliJ-style branch action set, built ONCE and shared by the Git
 * tool-window Branches tab and the status-bar branch popover. Pure: given a
 * branch + the ops, returns the ordered context-menu items. Labels are raw
 * strings to match the surrounding git-menu code (BranchRow).
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
  opts: { opInProgress?: boolean } = {},
): ContextMenuItem[] {
  const op = !!opts.opInProgress; // a sequencer op is mid-flight → gate merge/rebase/pull
  const items: ContextMenuItem[] = [];

  items.push({
    id: 'switch',
    label: b.isRemote ? 'Checkout as local branch' : 'Checkout',
    disabled: b.isCurrent,
    onSelect: () => actions.onSwitch(b),
  });
  items.push({ id: 'open-log', label: 'Open in log', onSelect: () => actions.onOpenLog(b) });
  items.push({
    id: 'new-from',
    separatorBefore: true,
    label: 'New branch from here…',
    icon: GitBranchPlus,
    onSelect: () => actions.onNewBranchFrom(b),
  });

  // Merge / rebase / pull act on the CURRENT branch relative to this one, so
  // they're meaningless on the current branch itself and gated mid-sequencer.
  if (!b.isCurrent) {
    items.push({
      id: 'merge',
      separatorBefore: true,
      label: `Merge '${b.name}' into current`,
      icon: GitMerge,
      disabled: op,
      onSelect: () => actions.onMerge(b),
    });
    items.push({
      id: 'rebase',
      label: `Rebase current onto '${b.name}'`,
      icon: GitGraph,
      disabled: op,
      onSelect: () => actions.onRebase(b),
    });
    if (b.isRemote) {
      items.push({
        id: 'pull',
        label: 'Pull into current',
        icon: ArrowDownToLine,
        disabled: op,
        submenu: [
          { id: 'pull-merge', label: 'Using Merge', onSelect: () => actions.onPull(b, 'merge') },
          { id: 'pull-rebase', label: 'Using Rebase', onSelect: () => actions.onPull(b, 'rebase') },
        ],
      });
    }
    items.push({
      id: 'compare',
      separatorBefore: true,
      label: 'Compare with current',
      icon: GitCompare,
      onSelect: () => actions.onCompare(b),
    });
    items.push({
      id: 'show-diff',
      label: 'Show diff with working tree',
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
      label: 'Update',
      icon: ArrowDownToLine,
      disabled: op,
      onSelect: () => actions.onUpdate(b),
    });
  }

  if (!b.isRemote) {
    items.push({ id: 'rename', separatorBefore: true, label: 'Rename…', icon: Pencil, onSelect: () => actions.onRename(b) });
    items.push({
      id: 'push',
      label: b.upstream ? 'Push' : 'Push (set upstream)',
      icon: Upload,
      onSelect: () => actions.onPush(b),
    });
    if (!b.isCurrent) {
      items.push({ id: 'delete', label: 'Delete', icon: Trash2, destructive: true, onSelect: () => actions.onDelete(b) });
    }
  }

  items.push({
    id: 'copy-name',
    separatorBefore: true,
    label: 'Copy name',
    icon: ClipboardCopy,
    onSelect: () => void navigator.clipboard.writeText(b.name).catch(() => undefined),
  });
  return items;
}
