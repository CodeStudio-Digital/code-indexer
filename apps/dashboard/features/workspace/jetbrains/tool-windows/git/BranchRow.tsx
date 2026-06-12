/**
 * One branch row in the Branches tab. Clicking the row OPENS the branch
 * log in the content area (it no longer checks out — that was a footgun:
 * an accidental click switched your branch). Every action lives behind a
 * right-click context menu (or the hover "⋯" button), JetBrains-style.
 */

import { GitBranch as GitBranchIcon, MoreHorizontal } from 'lucide-react';
import {
  ClipboardCopy,
  GitBranchPlus,
  GitMerge,
  Pencil,
  Trash2,
  Upload,
} from 'lucide-react';
import { useContextMenu, type ContextMenuItem } from '../../../../../components/ui/context-menu.js';
import { cn } from '../../../../../lib/utils.js';

export interface GitBranch {
  name: string;
  isCurrent: boolean;
  isRemote: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
  tipSubject: string;
}

export interface BranchRowActions {
  onOpenLog: (b: GitBranch) => void;
  onSwitch: (b: GitBranch) => void;
  onNewBranchFrom: (b: GitBranch) => void;
  onRename: (b: GitBranch) => void;
  onMerge: (b: GitBranch) => void;
  onPush: (b: GitBranch) => void;
  onDelete: (b: GitBranch) => void;
}

export function BranchRow({ branch: b, actions }: { branch: GitBranch; actions: BranchRowActions }) {
  const items: ContextMenuItem[] = [];
  // Switch / checkout — primary action, disabled on the current branch.
  items.push({
    id: 'switch',
    label: b.isRemote ? 'Checkout as local branch' : 'Switch to this branch',
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
  if (!b.isRemote) {
    items.push({ id: 'rename', label: 'Rename…', icon: Pencil, onSelect: () => actions.onRename(b) });
  }
  if (!b.isRemote && !b.isCurrent) {
    items.push({
      id: 'merge',
      separatorBefore: true,
      label: 'Merge into current branch',
      icon: GitMerge,
      onSelect: () => actions.onMerge(b),
    });
  }
  if (!b.isRemote) {
    items.push({
      id: 'push',
      separatorBefore: true,
      label: b.upstream ? 'Push' : 'Push (set upstream)',
      icon: Upload,
      onSelect: () => actions.onPush(b),
    });
  }
  if (!b.isRemote && !b.isCurrent) {
    items.push({
      id: 'delete',
      separatorBefore: true,
      label: 'Delete branch',
      icon: Trash2,
      destructive: true,
      onSelect: () => actions.onDelete(b),
    });
  }
  items.push({
    id: 'copy-name',
    separatorBefore: true,
    label: 'Copy name',
    icon: ClipboardCopy,
    onSelect: () => void navigator.clipboard.writeText(b.name).catch(() => undefined),
  });

  const { triggerProps, Menu } = useContextMenu(items);

  return (
    <>
      <div
        {...triggerProps}
        className={cn(
          'group flex items-center gap-1.5 px-2 py-1 border-b last:border-b-0 text-[11.5px] cursor-pointer transition-colors',
          b.isCurrent ? 'bg-primary/5' : 'hover:bg-muted/40',
        )}
        onClick={() => actions.onOpenLog(b)}
        title="Open log · right-click for actions"
      >
        <GitBranchIcon
          className={cn(
            'h-3 w-3 shrink-0',
            b.isCurrent ? 'text-primary' : b.isRemote ? 'text-sky-400' : 'text-muted-foreground/80',
          )}
        />
        <span
          className={cn(
            'truncate font-medium',
            b.isCurrent && 'text-foreground',
            b.isRemote && !b.isCurrent && 'text-muted-foreground',
          )}
        >
          {b.name}
        </span>
        {b.upstream && !b.isRemote && (
          <span className="text-[10px] text-muted-foreground/70 truncate">→ {b.upstream}</span>
        )}
        <span className="ml-auto flex items-center gap-2 text-[10px] text-muted-foreground shrink-0">
          {b.ahead > 0 && <span className="text-emerald-400">↑{b.ahead}</span>}
          {b.behind > 0 && <span className="text-sky-400">↓{b.behind}</span>}
        </span>
        <button
          type="button"
          className="h-5 w-5 grid place-items-center rounded-sm text-muted-foreground hover:text-foreground hover:bg-muted opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
          aria-label="Branch actions"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
            const evt = new MouseEvent('contextmenu', {
              bubbles: true,
              cancelable: true,
              view: window,
              clientX: rect.left,
              clientY: rect.bottom,
            });
            (e.currentTarget as HTMLElement).dispatchEvent(evt);
          }}
        >
          <MoreHorizontal className="h-3 w-3" />
        </button>
      </div>
      {Menu}
    </>
  );
}
