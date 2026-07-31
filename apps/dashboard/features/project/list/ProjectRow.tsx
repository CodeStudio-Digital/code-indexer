/**
 * Compact list-row for `ProjectList`, tuned for scanning many projects:
 *
 *   [folder] Name + path          655 files · 3249 syms   [status] [Index] [⋯]
 *
 * Memoized + fed stable callbacks from the parent: the compact list can be
 * 40+ rows, and heap profiling showed this row's per-render churn (a fresh
 * context-menu array + the per-row Radix `<Tooltip>` provider/portal) as a
 * source of allocation and detached-DOM residue. The visible ellipsis opens
 * the same lightweight context menu as right-click, so actions are discoverable
 * without adding one Radix menu provider per row.
 */
import { memo, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Ellipsis, FolderGit2, LoaderCircle } from 'lucide-react';
import { Badge } from '../../../components/ui/badge.js';
import { Button } from '../../../components/ui/button.js';
import { useContextMenu } from '../../../components/ui/context-menu.js';
import { formatRelativeTime } from '../../../lib/utils.js';
import type { ProjectCardData } from './ProjectCard.js';
import { buildProjectContextMenuItems } from './projectContextMenu.js';

export interface ProjectRowProps {
  project: ProjectCardData;
  /** Stable handlers from the parent (the row passes its own project back). */
  onSelect: (project: ProjectCardData) => void;
  onEdit: (project: ProjectCardData) => void;
  onIndex: (project: ProjectCardData) => void;
  indexing?: boolean;
}

export const ProjectRow = memo(function ProjectRow({
  project: p,
  onSelect,
  onEdit,
  onIndex,
  indexing = false,
}: ProjectRowProps) {
  const { t } = useTranslation(['projects', 'common']);
  const indexed = !!p.last_indexed;
  const statusLabel = indexed
    ? t('projects:indexStatus.indexed')
    : t('projects:indexStatus.notIndexed');

  const labels = useMemo(
    () => ({
      open: t('projects:contextMenu.open', 'Open'),
      openInNewWindow: t('projects:contextMenu.openInNewWindow', 'Open in new window'),
      openInExplorer: t('projects:contextMenu.openInExplorer', 'Open in file explorer'),
      copyPath: t('projects:contextMenu.copyPath', 'Copy path'),
      edit: t('projects:contextMenu.edit', 'Edit'),
      copied: t('projects:contextMenu.copied', 'Copied'),
      index: indexing
        ? t('projects:indexAction.indexing')
        : t('projects:indexAction.run'),
    }),
    [indexing, t],
  );
  const menuItems = useMemo(
    () =>
      buildProjectContextMenuItems({
        project: p,
        onSelect: () => onSelect(p),
        onEdit: () => onEdit(p),
        onIndex: indexed ? undefined : () => onIndex(p),
        indexing,
        labels,
      }),
    [p, onSelect, onEdit, onIndex, indexed, indexing, labels],
  );
  const { triggerProps, openAt, Menu } = useContextMenu(menuItems);

  return (
    <div
      onClick={() => onSelect(p)}
      {...triggerProps}
      className="group flex min-w-0 cursor-pointer items-center gap-3 border-b px-3 py-2.5 transition-colors last:border-b-0 hover:bg-accent/45 focus-within:bg-accent/45"
    >
      <button
        type="button"
        className="flex min-w-0 flex-1 items-center gap-3 rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-label={t('projects:openProject', { name: p.name })}
        onClick={(event) => {
          event.stopPropagation();
          onSelect(p);
        }}
      >
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground transition-colors group-hover:text-foreground">
          <FolderGit2 className="h-4 w-4" />
        </span>

        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{p.name}</span>
          <span
            className="block truncate font-mono text-[11px] text-muted-foreground"
            title={p.root_path}
          >
            {p.root_path}
          </span>
          <Badge
            variant={indexing ? 'info' : indexed ? 'success' : 'warning'}
            className="mt-1 w-fit normal-case tracking-normal md:hidden"
          >
            {indexing && <LoaderCircle className="mr-1 h-3 w-3 animate-spin" />}
            {indexing ? t('projects:indexAction.indexing') : statusLabel}
          </Badge>
        </span>
      </button>

      <div className="hidden w-[190px] shrink-0 text-right text-[11px] tabular-nums text-muted-foreground lg:block">
        <span>{p.file_count.toLocaleString()} {t('projects:files')}</span>
        <span className="px-1.5 opacity-40">·</span>
        <span>{p.symbol_count.toLocaleString()} {t('projects:symbols')}</span>
      </div>

      <div className="hidden w-[128px] shrink-0 text-right md:block">
        <Badge
          variant={indexing ? 'info' : indexed ? 'success' : 'warning'}
          className="ml-auto w-fit normal-case tracking-normal"
          title={
            p.last_indexed
              ? t('projects:indexStatus.lastIndexed', {
                  time: formatRelativeTime(p.last_indexed),
                })
              : statusLabel
          }
        >
          {indexing && <LoaderCircle className="mr-1 h-3 w-3 animate-spin" />}
          {indexing ? t('projects:indexAction.indexing') : statusLabel}
        </Badge>
      </div>

      {!indexed && (
        <Button
          variant="ghost"
          size="sm"
          className="hidden shrink-0 sm:inline-flex"
          disabled={indexing}
          onClick={(event) => {
            event.stopPropagation();
            onIndex(p);
          }}
        >
          {indexing && <LoaderCircle className="h-3.5 w-3.5 animate-spin" />}
          {indexing
            ? t('projects:indexAction.indexing')
            : t('projects:indexAction.run')}
        </Button>
      )}

      <Button
        variant="ghost"
        size="icon-sm"
        className="shrink-0 text-muted-foreground opacity-70 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
        onClick={(event) => {
          event.stopPropagation();
          const rect = event.currentTarget.getBoundingClientRect();
          openAt(Math.max(4, rect.right - 180), rect.bottom + 4);
        }}
        aria-label={t('projects:moreActions', { name: p.name })}
      >
        <Ellipsis className="h-4 w-4" />
      </Button>
      {Menu}
    </div>
  );
});
