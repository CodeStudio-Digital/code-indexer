/**
 * Single-row presentation for a stash entry inside `StashView`.
 *
 * Pure presentational: receives the entry + busy flag + 4 action
 * callbacks. The parent owns all data fetching and state. Hover-only
 * action icons mirror `BranchesView` (Apply / Pop / Drop) so the
 * surface stays familiar.
 */
import { Archive, ArrowUpFromLine, Eye, FilePlus, Trash2 } from 'lucide-react';
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
  onPop: () => void;
  onApply: () => void;
  onDrop: () => void;
  onShow: () => void;
}

export function StashRow({ entry, busy, onPop, onApply, onDrop, onShow }: StashRowProps) {
  // Drop the auto "WIP on branch:" prefix when present — the `branch`
  // field already shows it as a chip, so repeating it eats column width
  // on narrow panels.
  const display = entry.message.replace(/^(?:WIP on|On)\s+[^:]+:\s*/, '').trim() || '(no message)';
  return (
    <div
      className={cn(
        'group flex items-center gap-1.5 px-2 py-1 border-b last:border-b-0 text-[11.5px] transition-colors',
        busy ? 'opacity-60' : 'hover:bg-muted/40',
      )}
      title={entry.message}
    >
      <Archive className="h-3 w-3 shrink-0 text-amber-500/80" />
      <span className="font-mono text-[10px] text-muted-foreground shrink-0">{entry.shortSha}</span>
      {entry.branch && (
        <span className="text-[10px] text-muted-foreground/70 truncate shrink-0">
          {entry.branch}
        </span>
      )}
      <span className="truncate font-medium flex-1">{display}</span>
      <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
        <RowButton icon={Eye} title="Show diff" onClick={onShow} />
        <RowButton icon={FilePlus} title="Apply (keep stash)" onClick={onApply} />
        <RowButton icon={ArrowUpFromLine} title="Pop (apply + drop)" onClick={onPop} />
        <RowButton icon={Trash2} title="Drop stash" onClick={onDrop} destructive />
      </div>
    </div>
  );
}

function RowButton({
  icon: Icon,
  title,
  onClick,
  destructive,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  onClick: () => void;
  destructive?: boolean;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className={cn(
        'h-5 w-5 grid place-items-center rounded-sm transition-colors',
        destructive
          ? 'text-muted-foreground hover:text-destructive hover:bg-destructive/10'
          : 'text-muted-foreground hover:text-foreground hover:bg-muted',
      )}
    >
      <Icon className="h-3 w-3" />
    </button>
  );
}
