/**
 * A generation-batch header row in the Frames browser: collapse chevron, the
 * label ("job#40 · idle · 6f" | "manual · Nf"), a tri-state group checkbox and
 * a group-delete affordance. Reads the session store to compute how many of the
 * group's versions are selected (tri-state).
 */
import { useRef, useState } from 'react';
import { ChevronDown, ChevronRight, Pencil, RotateCcw, Scissors, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '../../../../lib/utils.js';
import { useAnimateSession } from '../animate-session-store.js';
import type { FrameGroupView } from '../version-groups.js';

export function VersionGroupHeader({
  group,
  collapsed,
  customLabel,
  onToggleCollapse,
  onGroupSelect,
  onGroupDelete,
  onRestoreGroup,
  onReslice,
  onRename,
}: {
  group: FrameGroupView;
  collapsed: boolean;
  /** User-set display name for this group; falls back to the synthesized one. */
  customLabel?: string;
  onToggleCollapse: (key: string) => void;
  onGroupSelect: (ids: number[], on: boolean) => void;
  onGroupDelete: (group: FrameGroupView) => void;
  /** Restore this whole batch as the open animation's timeline. */
  onRestoreGroup: (group: FrameGroupView) => void;
  /** Re-slice this batch's original sheet with a custom grid. */
  onReslice: (group: FrameGroupView) => void;
  /** Persist a custom group name ('' clears it back to the synthesized label). */
  onRename: (group: FrameGroupView, name: string) => void;
}) {
  const { t } = useTranslation('spriteStudio');
  const ids = group.versions.map((v) => v.id);
  const selectedCount = useAnimateSession((s) => ids.reduce((n, id) => n + (s.selected.has(id) ? 1 : 0), 0));
  const allSelected = ids.length > 0 && selectedCount === ids.length;
  const someSelected = selectedCount > 0 && !allSelected;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  // Set on Escape so the blur that fires when the input unmounts DOESN'T commit.
  const cancelRef = useRef(false);

  const synthesized = group.jobId == null
    ? t('frames.group.manual', { n: group.count })
    : group.animationName
      ? t('frames.group.job', { id: group.jobId, name: group.animationName, n: group.count })
      : t('frames.group.jobNoName', { id: group.jobId, n: group.count });
  const label = customLabel && customLabel.trim() ? customLabel : synthesized;

  const startEdit = () => { cancelRef.current = false; setDraft(customLabel ?? ''); setEditing(true); };
  const commit = () => {
    if (cancelRef.current) { cancelRef.current = false; setEditing(false); return; }
    onRename(group, draft.trim());
    setEditing(false);
  };

  return (
    <div className="group/header flex items-center gap-1 px-1.5 py-1 text-[11px]">
      {editing ? (
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); commit(); }
            else if (e.key === 'Escape') { cancelRef.current = true; setEditing(false); }
          }}
          placeholder={synthesized}
          aria-label={t('frames.renameGroup')}
          className="min-w-0 flex-1 rounded border bg-background px-1 py-0.5 text-[11px] outline-none focus:border-primary"
        />
      ) : (
        <button
          type="button"
          onClick={() => onToggleCollapse(group.key)}
          className="flex min-w-0 flex-1 items-center gap-1 text-left text-muted-foreground hover:text-foreground"
        >
          {collapsed ? <ChevronRight className="h-3 w-3 shrink-0" /> : <ChevronDown className="h-3 w-3 shrink-0" />}
          <span className="min-w-0 truncate font-medium">{label}</span>
        </button>
      )}
      <button
        type="button"
        aria-label={t('frames.renameGroup')}
        title={t('frames.renameGroup')}
        onClick={startEdit}
        className="shrink-0 rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:bg-primary/15 hover:text-primary group-hover/header:opacity-100"
      >
        <Pencil className="h-3 w-3" />
      </button>
      {/* Primary batch actions stay ALWAYS visible (hover-only killed
          discoverability — the user never found the scissors). */}
      {group.hasSheet && (
        <button
          type="button"
          aria-label={t('frames.reslice')}
          title={t('frames.reslice')}
          onClick={() => onReslice(group)}
          className="shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:bg-primary/15 hover:text-primary"
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
          className="shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:bg-primary/15 hover:text-primary"
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
