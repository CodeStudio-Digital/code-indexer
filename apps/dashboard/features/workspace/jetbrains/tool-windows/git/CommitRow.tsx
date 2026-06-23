/**
 * One commit row — shared by the History tab (narrow panel) and the
 * branch Log surface (content area, with selection + side preview).
 *
 * Right-click (or the hover "⋯" button) opens the same JetBrains-style
 * context menu: cherry-pick / revert / reset (soft·mixed·hard) / copy
 * SHA. When `onSelect` is provided the row also acts as a selectable
 * list item (drives the commit preview panel).
 */

import {
  ClipboardCopy,
  GitCommit,
  MoreHorizontal,
  Replace,
  RotateCcw,
} from 'lucide-react';
import { useContextMenu, type ContextMenuItem } from '../../../../../components/ui/context-menu.js';
import { cn } from '../../../../../lib/utils.js';

export interface Commit {
  sha: string;
  shortSha: string;
  author: string;
  date: string;
  subject: string;
}

export interface CommitRowProps {
  commit: Commit;
  onCherryPick: () => void;
  onRevert: () => void;
  onReset: (mode: 'soft' | 'mixed' | 'hard') => void;
  /** When set, the row is selectable and fires this on click. */
  onSelect?: () => void;
  selected?: boolean;
  /** A merge/cherry-pick/etc. is mid-flight — disable history-rewriting actions. */
  disabled?: boolean;
}

export function CommitRow({
  commit: c,
  onCherryPick,
  onRevert,
  onReset,
  onSelect,
  selected,
  disabled,
}: CommitRowProps) {
  const items: ContextMenuItem[] = [
    {
      id: 'cherry-pick',
      label: 'Cherry-pick onto current branch',
      icon: Replace,
      disabled,
      onSelect: onCherryPick,
    },
    {
      id: 'revert',
      label: 'Revert (new commit that undoes this)',
      icon: RotateCcw,
      disabled,
      onSelect: onRevert,
    },
    {
      id: 'reset-soft',
      separatorBefore: true,
      label: 'Reset HEAD → here (soft)',
      disabled,
      onSelect: () => onReset('soft'),
    },
    {
      id: 'reset-mixed',
      label: 'Reset HEAD → here (mixed)',
      disabled,
      onSelect: () => onReset('mixed'),
    },
    {
      id: 'reset-hard',
      label: 'Reset HEAD → here (hard, destructive)',
      destructive: true,
      disabled,
      onSelect: () => onReset('hard'),
    },
    {
      id: 'copy-sha',
      separatorBefore: true,
      label: 'Copy full SHA',
      icon: ClipboardCopy,
      onSelect: () => {
        void navigator.clipboard.writeText(c.sha).catch(() => undefined);
      },
    },
  ];
  const { triggerProps, Menu } = useContextMenu(items);

  return (
    <>
      <div
        {...triggerProps}
        onClick={onSelect}
        className={cn(
          'group flex items-center gap-1.5 px-2 py-1 border-b last:border-b-0 text-[11.5px] transition-colors',
          onSelect && 'cursor-pointer',
          selected ? 'bg-primary/10' : 'hover:bg-muted/40',
        )}
        title={c.subject}
      >
        <GitCommit className="h-3 w-3 text-muted-foreground/60 shrink-0" />
        <span className="font-mono text-[10px] text-muted-foreground w-14 shrink-0 truncate">
          {c.shortSha}
        </span>
        <span className="truncate flex-1">{c.subject}</span>
        <span className="text-[10px] text-muted-foreground/70 max-w-[110px] truncate shrink-0">
          {c.author}
        </span>
        <span className="text-[10px] text-muted-foreground/60 shrink-0">
          {formatDate(c.date)}
        </span>
        <button
          type="button"
          className="h-5 w-5 grid place-items-center rounded-sm text-muted-foreground hover:text-foreground hover:bg-muted opacity-0 group-hover:opacity-100 transition-opacity"
          aria-label="More actions"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            // Open the context menu by simulating a right-click at the
            // button's coordinates.
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

export function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  const now = Date.now();
  const diff = now - d.getTime();
  if (diff < 60_000) return 'now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)}d`;
  return d.toLocaleDateString();
}
