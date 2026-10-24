/**
 * Single-row presentation for a stash entry inside `StashView`.
 *
 * Clicking the row OPENS the stash preview (files + per-file diff) in the
 * content area — same idea as clicking a commit. Every action lives
 * behind a labeled context menu (right-click or the hover "⋯" button) so
 * the functions read clearly instead of as a row of cryptic icons.
 */
import { Archive, MoreHorizontal } from 'lucide-react';
import { useTranslation } from 'react-i18next';
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

interface StashRowEntry {
  index: string;
  shortSha: string;
  branch: string | null;
  message: string;
}

interface StashRowProps {
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
  const { t } = useTranslation('workspace');
  // Drop the auto "WIP on branch:" prefix when present — the `branch`
  // field already shows it as a chip, so repeating it eats column width
  // on narrow panels.
  const display = entry.message.replace(/^(?:WIP on|On)\s+[^:]+:\s*/, '').trim() || t('git.stash.noMessage');

  const items: ContextMenuItem[] = [
    { id: 'open', label: t('git.stash.open'), icon: FolderOpen, onSelect: onOpen },
    { id: 'show', label: t('git.stash.showCombined'), icon: Eye, onSelect: onShow },
    { id: 'apply', separatorBefore: true, label: t('git.stash.applyKeep'), icon: FilePlus, disabled: opInProgress, onSelect: onApply },
    { id: 'pop', label: t('git.stash.popDrop'), icon: ArrowUpFromLine, disabled: opInProgress, onSelect: onPop },
    {
      id: 'drop',
      separatorBefore: true,
      label: t('git.stash.drop'),
      icon: Trash2,
      destructive: true,
      onSelect: onDrop,
    },
    {
      id: 'copy-ref',
      separatorBefore: true,
      label: t('git.stash.copyRef'),
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
        role="button"
        tabIndex={busy ? -1 : 0}
        onKeyDown={(event) => {
          if (!busy && (event.key === 'Enter' || event.key === ' ')) {
            event.preventDefault();
            onOpen();
          }
        }}
        className={cn(
          'group flex items-center gap-1.5 px-2 py-1 border-b last:border-b-0 text-[11.5px] transition-colors',
          busy ? 'opacity-60' : 'hover:bg-muted/40 cursor-pointer',
        )}
        title={t('git.stash.openActions')}
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
          aria-label={t('git.stash.actions')}
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
