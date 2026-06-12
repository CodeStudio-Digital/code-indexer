/**
 * Single compact row in `SnapshotList` — one snapshot per line. Renders
 * the category chip + title + relative timestamp; expands into a second
 * line when the user has tagged the snapshot beyond the default
 * `auto-generated` marker. Selection state highlights the row in
 * `bg-accent`, mirroring VS Code's outline pane.
 */
import { cn, formatRelativeTime } from '../../../lib/utils.js';
import { CATEGORY_COLORS, parseTags, type Snapshot } from '../snapshot-types.js';

interface SnapshotRowProps {
  snapshot: Snapshot;
  selected: boolean;
  onSelect: () => void;
}

export function SnapshotRow({ snapshot: s, selected, onSelect }: SnapshotRowProps) {
  const tags = parseTags(s.tags).filter((t) => t !== 'auto-generated');
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={selected ? 'true' : undefined}
      className={cn(
        'w-full text-left px-2 py-1.5 rounded-md transition-colors group',
        'flex flex-col gap-1 min-w-0',
        selected
          ? 'bg-accent text-accent-foreground'
          : 'hover:bg-muted/60 text-foreground/90',
      )}
    >
      <div className="flex items-center gap-1.5 min-w-0">
        <span
          className={cn(
            'px-1.5 py-0.5 rounded text-[9px] font-medium capitalize shrink-0',
            CATEGORY_COLORS[s.category] ?? CATEGORY_COLORS.note,
          )}
        >
          {s.category}
        </span>
        <span className="text-xs font-medium truncate flex-1">{s.title}</span>
      </div>
      <div className="flex items-center gap-1 text-[10px] text-muted-foreground min-w-0">
        <span className="shrink-0">{formatRelativeTime(s.created_at)}</span>
        {s.source && s.source !== 'manual' && (
          <span className="shrink-0 px-1 rounded bg-muted text-[9px]">{s.source}</span>
        )}
        {tags.length > 0 && (
          <>
            <span className="opacity-40">·</span>
            <span className="truncate">{tags.join(', ')}</span>
          </>
        )}
      </div>
    </button>
  );
}
