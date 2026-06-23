/**
 * Compact list-row for `ProjectList` — single row per project, ~36px
 * tall, used in the "compact" layout toggle. Information density is
 * tuned for scanning many projects (18+ becomes painful in card view):
 *
 *   [● status]  Name              path/...                  655 files · 3249 syms · 14/04   [✎]
 *
 * The status dot replaces the full Badge from `ProjectCard` — color
 * carries the same signal (green=indexed, muted=pending) in 8px
 * instead of ~70px of horizontal real estate. Files / symbols / date
 * sit right-aligned with `·` separators so the row reads naturally.
 *
 * Memoized + fed stable callbacks from the parent: the compact list can be
 * 40+ rows, and heap profiling showed this row's per-render churn (a fresh
 * context-menu array + the per-row Radix `<Tooltip>` provider/portal) as a
 * source of allocation and detached-DOM residue. The status hint is now a
 * native `title`/`aria-label` (same string, zero JS/DOM cost).
 */
import { memo, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Clock, Pencil } from 'lucide-react';
import { Button } from '../../../components/ui/button.js';
import { useContextMenu } from '../../../components/ui/context-menu.js';
import { cn, formatRelativeTime } from '../../../lib/utils.js';
import type { ProjectCardData } from './ProjectCard.js';
import { buildProjectContextMenuItems } from './projectContextMenu.js';

export interface ProjectRowProps {
  project: ProjectCardData;
  /** Stable handlers from the parent (the row passes its own project back). */
  onSelect: (project: ProjectCardData) => void;
  onEdit: (project: ProjectCardData) => void;
}

export const ProjectRow = memo(function ProjectRow({ project: p, onSelect, onEdit }: ProjectRowProps) {
  const { t } = useTranslation(['projects', 'common']);
  const indexed = !!p.last_indexed;
  const statusLabel = indexed ? t('common:status.indexed') : t('common:status.pending');

  const labels = useMemo(
    () => ({
      open: t('projects:contextMenu.open', 'Open'),
      openInNewWindow: t('projects:contextMenu.openInNewWindow', 'Open in new window'),
      openInExplorer: t('projects:contextMenu.openInExplorer', 'Open in file explorer'),
      copyPath: t('projects:contextMenu.copyPath', 'Copy path'),
      edit: t('projects:contextMenu.edit', 'Edit'),
      copied: t('projects:contextMenu.copied', 'Copied'),
    }),
    [t],
  );
  const menuItems = useMemo(
    () =>
      buildProjectContextMenuItems({
        project: p,
        onSelect: () => onSelect(p),
        onEdit: () => onEdit(p),
        labels,
      }),
    [p, onSelect, onEdit, labels],
  );
  const { triggerProps, Menu } = useContextMenu(menuItems);

  return (
    <div
      onClick={() => onSelect(p)}
      {...triggerProps}
      className={cn(
        'group flex items-center gap-2.5 px-3 py-2 rounded-md border bg-card cursor-pointer',
        'hover:border-primary/40 hover:bg-card/80 transition-colors',
      )}
    >
      {/* Status dot — green when indexed, muted otherwise. Replaces the full
          Badge from the card view to save ~70px of width. The hover hint is a
          native title (was a per-row Radix Tooltip — see file header). */}
      <span
        className={cn(
          'h-2 w-2 rounded-full shrink-0',
          indexed ? 'bg-emerald-500' : 'bg-muted-foreground/40',
        )}
        title={statusLabel}
        aria-label={statusLabel}
      />

      <span className="font-medium text-sm truncate shrink-0 max-w-[260px]">{p.name}</span>

      <span
        className="text-xs text-muted-foreground font-mono truncate flex-1 min-w-0"
        title={p.root_path}
      >
        {p.root_path}
      </span>

      {/* Stats — right-aligned, tabular nums so the columns line up
          visually across rows. Hidden on very narrow screens where
          they'd wrap the row. */}
      <div className="hidden md:flex items-center gap-3 text-[11px] text-muted-foreground shrink-0 tabular-nums">
        <span>
          <strong className="text-foreground">{p.file_count.toLocaleString()}</strong>{' '}
          {t('projects:files')}
        </span>
        <span className="opacity-40">·</span>
        <span>
          <strong className="text-foreground">{p.symbol_count.toLocaleString()}</strong>{' '}
          {t('projects:symbols')}
        </span>
        <span className="opacity-40">·</span>
        <span className="inline-flex items-center gap-1 min-w-[60px]">
          <Clock className="h-3 w-3" />
          {p.last_indexed ? formatRelativeTime(p.last_indexed) : t('projects:neverIndexed')}
        </span>
      </div>

      <Button
        variant="ghost"
        size="icon"
        className="h-7 w-7 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity"
        onClick={(e) => {
          e.stopPropagation();
          onEdit(p);
        }}
        aria-label={t('projects:editProject')}
      >
        <Pencil className="h-3.5 w-3.5" />
      </Button>
      {Menu}
    </div>
  );
});
