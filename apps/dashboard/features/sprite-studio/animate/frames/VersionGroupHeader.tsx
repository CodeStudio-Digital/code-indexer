/**
 * A generation-batch header row in the Frames browser: collapse chevron, the
 * label ("job#40 · idle · 6f" | "manual · Nf"), a tri-state group checkbox and
 * a group-delete affordance. Reads the session store to compute how many of the
 * group's versions are selected (tri-state).
 */
import { ChevronDown, ChevronRight, RotateCcw, Scissors, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '../../../../lib/utils.js';
import { useAnimateSession } from '../animate-session-store.js';
import type { FrameGroupView } from '../version-groups.js';

export function VersionGroupHeader({
  group,
  collapsed,
  onToggleCollapse,
  onGroupSelect,
  onGroupDelete,
  onRestoreGroup,
  onReslice,
}: {
  group: FrameGroupView;
  collapsed: boolean;
  onToggleCollapse: (key: string) => void;
  onGroupSelect: (ids: number[], on: boolean) => void;
  onGroupDelete: (group: FrameGroupView) => void;
  /** Restore this whole batch as the open animation's timeline. */
  onRestoreGroup: (group: FrameGroupView) => void;
  /** Re-slice this batch's original sheet with a custom grid. */
  onReslice: (group: FrameGroupView) => void;
}) {
  const { t } = useTranslation('spriteStudio');
  const ids = group.versions.map((v) => v.id);
  const selectedCount = useAnimateSession((s) => ids.reduce((n, id) => n + (s.selected.has(id) ? 1 : 0), 0));
  const allSelected = ids.length > 0 && selectedCount === ids.length;
  const someSelected = selectedCount > 0 && !allSelected;

  const label = group.jobId == null
    ? t('frames.group.manual', { n: group.count })
    : group.animationName
      ? t('frames.group.job', { id: group.jobId, name: group.animationName, n: group.count })
      : t('frames.group.jobNoName', { id: group.jobId, n: group.count });

  return (
    <div className="group/header flex items-center gap-1 px-1.5 py-1 text-[11px]">
      <button
        type="button"
        onClick={() => onToggleCollapse(group.key)}
        className="flex min-w-0 flex-1 items-center gap-1 text-left text-muted-foreground hover:text-foreground"
      >
        {collapsed ? <ChevronRight className="h-3 w-3 shrink-0" /> : <ChevronDown className="h-3 w-3 shrink-0" />}
        <span className="min-w-0 truncate font-medium">{label}</span>
      </button>
      {group.hasSheet && (
        <button
          type="button"
          aria-label={t('frames.reslice')}
          title={t('frames.reslice')}
          onClick={() => onReslice(group)}
          className="shrink-0 rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:bg-primary/15 hover:text-primary group-hover/header:opacity-100"
        >
          <Scissors className="h-3 w-3" />
        </button>
      )}
      {group.count > 0 && (
        <button
          type="button"
          aria-label={t('frames.restore')}
          title={t('frames.restore')}
          onClick={() => onRestoreGroup(group)}
          className="shrink-0 rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:bg-primary/15 hover:text-primary group-hover/header:opacity-100"
        >
          <RotateCcw className="h-3 w-3" />
        </button>
      )}
      <button
        type="button"
        aria-label={t('frames.selectGroup')}
        title={t('frames.selectGroup')}
        onClick={() => onGroupSelect(ids, !allSelected)}
        className={cn(
          'flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-sm border text-[9px]',
          allSelected ? 'border-primary bg-primary text-primary-foreground'
            : someSelected ? 'border-primary bg-primary/30' : 'border-muted-foreground/40',
        )}
      >
        {allSelected ? '✓' : someSelected ? '–' : ''}
      </button>
      <button
        type="button"
        aria-label={t('frames.deleteGroup')}
        title={t('frames.deleteGroup')}
        onClick={() => onGroupDelete(group)}
        className="shrink-0 rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:bg-red-500/15 hover:text-red-400 group-hover/header:opacity-100"
      >
        <Trash2 className="h-3 w-3" />
      </button>
    </div>
  );
}
