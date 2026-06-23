/**
 * Sidebar list for `SnapshotEditor`. Header carries the category filter
 * chips + a `+ New` button; body is a scrollable column of compact
 * `SnapshotRow`s. Search input filters by title (client-side — the
 * backend already returns the full set for the active category).
 *
 * The category-chip row is its own group so the "Todos" chip can sit
 * flush left and the typed chips wrap below on narrow widths.
 */
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, Search } from 'lucide-react';
import { Input } from '../../../components/ui/input.js';
import { cn } from '../../../lib/utils.js';
import { CATEGORIES, type Snapshot } from '../snapshot-types.js';
import { SnapshotRow } from './SnapshotRow.js';

interface SnapshotListProps {
  snapshots: Snapshot[];
  selectedId: number | null;
  filterCategory: string;
  onFilterCategory: (c: string) => void;
  onSelect: (id: number) => void;
  onNew: () => void;
}

export function SnapshotList({
  snapshots,
  selectedId,
  filterCategory,
  onFilterCategory,
  onSelect,
  onNew,
}: SnapshotListProps) {
  const { t } = useTranslation(['projects', 'common']);
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return snapshots;
    return snapshots.filter((s) => s.title.toLowerCase().includes(q));
  }, [snapshots, query]);

  return (
    <div className="flex flex-col h-full min-h-0 bg-card/40 border-r">
      <div className="px-2.5 py-2 border-b shrink-0 space-y-2">
        <div className="flex items-center gap-2">
          <h3 className="text-xs font-semibold flex-1 truncate">
            {t('projects:snapshots.title')}
          </h3>
          <button
            type="button"
            onClick={onNew}
            aria-label={t('projects:snapshots.newSnapshot')}
            title={t('projects:snapshots.newSnapshot')}
            className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground"
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
        </div>
        <div className="relative">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('common:actions.search', 'Search')}
            className="pl-7 h-7 text-xs"
          />
        </div>
        <div className="flex flex-wrap gap-1">
          <CategoryChip
            label={t('projects:snapshots.all', 'Todos')}
            active={!filterCategory}
            onClick={() => onFilterCategory('')}
          />
          {CATEGORIES.map((c) => (
            <CategoryChip
              key={c}
              label={c}
              active={filterCategory === c}
              onClick={() => onFilterCategory(filterCategory === c ? '' : c)}
            />
          ))}
        </div>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto p-1 space-y-0.5">
        {filtered.length === 0 ? (
          <p className="text-[11px] text-muted-foreground text-center py-6 px-3">
            {query
              ? t('projects:snapshots.noMatch', 'No snapshots match this search.')
              : filterCategory
                ? t('projects:snapshots.noInCategory', { category: filterCategory })
                : t('projects:snapshots.none')}
          </p>
        ) : (
          filtered.map((s) => (
            <SnapshotRow
              key={s.id}
              snapshot={s}
              selected={s.id === selectedId}
              onSelect={() => onSelect(s.id)}
            />
          ))
        )}
      </div>
    </div>
  );
}

function CategoryChip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'px-1.5 py-0.5 rounded text-[10px] capitalize transition-colors',
        active
          ? 'bg-primary text-primary-foreground'
          : 'bg-muted text-muted-foreground hover:bg-muted/80',
      )}
    >
      {label}
    </button>
  );
}
