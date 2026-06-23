/**
 * Single-row presentation for a stash entry inside `StashView`.
 *
 * Clicking the row OPENS the stash preview (files + per-file diff) in the
 * content area — same idea as clicking a commit. Every action lives
 * behind a labeled context menu (right-click or the hover "⋯" button) so
 * the functions read clearly instead of as a row of cryptic icons.
 */
import { Archive, MoreHorizontal } from 'lucide-react';
import {
  ArrowUpFromLine,
  ClipboardCopy,
  Eye,
  FilePlus,
  FolderOpen,
  Trash2,
} from 'lucide-react';
import { useContextMenu, type ContextMenuItem } from '../../../../../components/ui/context-menu.js';
import { cn } from '../../../../../lib/utils.js';

export interface StashRowEntry {
  index: string;
  shortSha: string;
  branch: string | null;
  message: string;
}

export interface StashRowProps {
  entry: StashRowEntry;
  busy: boolean;
  onOpen: () => void;
  onPop: () => void;
  onApply: () => void;
  onDrop: () => void;
  onShow: () => void;
  /** A conflict is already in progress — block apply/pop (they'd stack conflicts). */
  opInProgress?: boolean;
}

export function StashRow({ entry, busy, onOpen, onPop, onApply, onDrop, onShow, opInProgress }: StashRowProps) {
  // Drop the auto "WIP on branch:" prefix when present — the `branch`
  // field already shows it as a chip, so repeating it eats column width
  // on narrow panels.
  const display = entry.message.replace(/^(?:WIP on|On)\s+[^:]+:\s*/, '').trim() || '(no message)';

  const items: ContextMenuItem[] = [
    { id: 'open', label: 'Open (show stashed files)', icon: FolderOpen, onSelect: onOpen },
    { id: 'show', label: 'Show combined diff', icon: Eye, onSelect: onShow },
    { id: 'apply', separatorBefore: true, label: 'Apply (keep stash)', icon: FilePlus, disabled: opInProgress, onSelect: onApply },
    { id: 'pop', label: 'Pop (apply + drop)', icon: ArrowUpFromLine, disabled: opInProgress, onSelect: onPop },
    {
      id: 'drop',
      separatorBefore: true,
      label: 'Drop stash',
      icon: Trash2,
      destructive: true,
      onSelect: onDrop,
    },
    {
      id: 'copy-ref',
      separatorBefore: true,
      label: 'Copy ref',
      icon: ClipboardCopy,
      onSelect: () => void navigator.clipboard.writeText(entry.index).catch(() => undefined),
    },
  ];
  const { triggerProps, Menu } = useContextMenu(items);

  return (
    <>
      <div
        {...triggerProps}
        onClick={busy ? undefined : onOpen}
        className={cn(
          'group flex items-center gap-1.5 px-2 py-1 border-b last:border-b-0 text-[11.5px] transition-colors',
          busy ? 'opacity-60' : 'hover:bg-muted/40 cursor-pointer',
        )}
        title="Open stash · right-click for actions"
      >
        <Archive className="h-3 w-3 shrink-0 text-amber-500/80" />
        <span className="font-mono text-[10px] text-muted-foreground shrink-0">{entry.shortSha}</span>
        {entry.branch && (
          <span className="text-[10px] text-muted-foreground/70 truncate shrink-0">
            {entry.branch}
          </span>
        )}
        <span className="truncate font-medium flex-1">{display}</span>
        <button
          type="button"
          className="h-5 w-5 grid place-items-center rounded-sm text-muted-foreground hover:text-foreground hover:bg-muted opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
          aria-label="Stash actions"
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
