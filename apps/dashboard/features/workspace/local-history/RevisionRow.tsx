/**
 * Uma linha da lista de revisões do Local History: horário, badge de origem
 * (kind), rótulo e tamanho. Cores por kind reusam a convenção da paleta.
 */
import { memo } from 'react';
import { Tag } from 'lucide-react';
import { cn } from '../../../lib/utils.js';
import { parseDbDate } from '../../../lib/datetime.js';
import type { HistoryRevision } from '../../../state/local-history-store.js';

const KIND_META: Record<HistoryRevision['kind'], { label: string; cls: string }> = {
  save: { label: 'Save', cls: 'text-muted-foreground' },
  external: { label: 'External', cls: 'text-amber-400' },
  'pre-delete': { label: 'Deleted', cls: 'text-destructive' },
  'pre-agent': { label: 'Agent', cls: 'text-primary' },
  manual: { label: 'Label', cls: 'text-accent-foreground' },
};

/** created_at do SQLite é UTC sem 'Z'; parseDbDate normaliza para a TZ local. */
export function formatWhen(createdAt: string): string {
  const d = parseDbDate(createdAt);
  if (!d) return createdAt;
  const diffMs = Date.now() - d.getTime();
  const min = Math.floor(diffMs / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

interface RevisionRowProps {
  rev: HistoryRevision;
  selected: boolean;
  onSelect: (id: number) => void;
}

function RevisionRowImpl({ rev, selected, onSelect }: RevisionRowProps) {
  const meta = KIND_META[rev.kind];
  return (
    <button
      type="button"
      onClick={() => onSelect(rev.id)}
      className={cn(
        'w-full text-left px-2.5 py-1.5 border-b flex flex-col gap-0.5 transition-colors',
        selected ? 'bg-accent text-foreground' : 'hover:bg-muted/50',
      )}
    >
      <div className="flex items-center gap-1.5 text-[11.5px]">
        <span className={cn('font-medium', meta.cls)}>{meta.label}</span>
        <span className="text-muted-foreground/70">·</span>
        <span className="text-muted-foreground">{formatWhen(rev.created_at)}</span>
        {rev.oversized === 1 && <span className="ml-auto text-[10px] text-muted-foreground/70">no preview</span>}
      </div>
      {rev.label && (
        <div className="flex items-center gap-1 text-[11px] text-accent-foreground">
          <Tag className="h-3 w-3 shrink-0" />
          <span className="truncate">{rev.label}</span>
        </div>
      )}
      <div className="text-[10px] text-muted-foreground/70">
        {rev.existed_before === 0 ? '(did not exist)' : humanSize(rev.size)}
      </div>
    </button>
  );
}

export const RevisionRow = memo(RevisionRowImpl);
