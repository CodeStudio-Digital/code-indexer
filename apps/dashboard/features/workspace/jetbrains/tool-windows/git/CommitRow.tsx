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
import { useTranslation } from 'react-i18next';
import { useContextMenu, type ContextMenuItem } from '../../../../../components/ui/context-menu.js';
import { cn } from '../../../../../lib/utils.js';
import { GitGraphCell, type GitGraphRow } from './git-graph.js';

export interface Commit {
  sha: string;
  shortSha: string;
  author: string;
  date: string;
  subject: string;
  parents?: string[];
  refs?: string[];
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
  graph?: GitGraphRow;
  graphMaxLanes?: number;
}

export function CommitRow({
  commit: c,
  onCherryPick,
  onRevert,
  onReset,
  onSelect,
  selected,
  disabled,
  graph,
  graphMaxLanes,
}: CommitRowProps) {
  const { t } = useTranslation('workspace');
  const items: ContextMenuItem[] = [
    {
      id: 'cherry-pick',
      label: t('git.commitMenu.cherryPick'),
      icon: Replace,
      disabled,
      onSelect: onCherryPick,
    },
    {
      id: 'revert',
      label: t('git.commitMenu.revert'),
      icon: RotateCcw,
      disabled,
      onSelect: onRevert,
    },
    {
      id: 'reset-soft',
      separatorBefore: true,
      label: t('git.commitMenu.resetSoft'),
      disabled,
      onSelect: () => onReset('soft'),
    },
    {
      id: 'reset-mixed',
      label: t('git.commitMenu.resetMixed'),
      disabled,
      onSelect: () => onReset('mixed'),
    },
    {
      id: 'reset-hard',
      label: t('git.commitMenu.resetHard'),
      destructive: true,
      disabled,
      onSelect: () => onReset('hard'),
    },
    {
      id: 'copy-sha',
      separatorBefore: true,
      label: t('git.commitMenu.copySha'),
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
        role={onSelect ? 'button' : undefined}
        tabIndex={onSelect ? 0 : undefined}
        onKeyDown={onSelect ? (event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            onSelect();
          }
        } : undefined}
        className={cn(
          'group flex min-h-8 items-center gap-1.5 px-2 py-0 border-b last:border-b-0 text-[11.5px] transition-colors',
          onSelect && 'cursor-pointer',
          selected ? 'bg-primary/10' : 'hover:bg-muted/40',
        )}
        title={c.subject}
      >
        {graph && graphMaxLanes ? (
          <GitGraphCell row={graph} maxLanes={graphMaxLanes} selected={selected} />
        ) : (
          <GitCommit className="h-3 w-3 text-muted-foreground/60 shrink-0" />
        )}
        <span className="font-mono text-[10px] text-muted-foreground w-14 shrink-0 truncate">
          {c.shortSha}
        </span>
        {(c.refs?.length ?? 0) > 0 && (
          <span className="flex max-w-[180px] shrink-0 items-center gap-1 overflow-hidden">
            {c.refs?.slice(0, 2).map((ref) => (
              <span
                key={ref}
                className="max-w-[86px] truncate rounded-sm border border-primary/25 bg-primary/10 px-1 py-px text-[9px] leading-3 text-primary"
                title={ref}
              >
                {ref.replace(/^HEAD -> /, '')}
              </span>
            ))}
          </span>
        )}
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
          aria-label={t('git.moreActions')}
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
