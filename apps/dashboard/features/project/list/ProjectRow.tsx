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
 */
import { useTranslation } from 'react-i18next';
import { Clock, Pencil } from 'lucide-react';
import { Button } from '../../../components/ui/button.js';
import { Tooltip, TooltipContent, TooltipTrigger } from '../../../components/ui/tooltip.js';
import { cn, formatRelativeTime } from '../../../lib/utils.js';
import type { ProjectCardData } from './ProjectCard.js';

export interface ProjectRowProps {
  project: ProjectCardData;
  onSelect: () => void;
  onEdit: () => void;
}

export function ProjectRow({ project: p, onSelect, onEdit }: ProjectRowProps) {
  const { t } = useTranslation(['projects', 'common']);
  const indexed = !!p.last_indexed;
  return (
    <div
      onClick={onSelect}
      className={cn(
        'group flex items-center gap-2.5 px-3 py-2 rounded-md border bg-card cursor-pointer',
        'hover:border-primary/40 hover:bg-card/80 transition-colors',
      )}
    >
      {/* Status dot — green when indexed, muted otherwise. Replaces
          the full Badge from the card view to save ~70px of width. */}
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            className={cn(
              'h-2 w-2 rounded-full shrink-0',
              indexed ? 'bg-emerald-500' : 'bg-muted-foreground/40',
            )}
            aria-label={indexed ? t('common:status.indexed') : t('common:status.pending')}
          />
        </TooltipTrigger>
        <TooltipContent side="top">
          {indexed ? t('common:status.indexed') : t('common:status.pending')}
        </TooltipContent>
      </Tooltip>

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
          onEdit();
        }}
        aria-label={t('projects:editProject')}
      >
        <Pencil className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}
