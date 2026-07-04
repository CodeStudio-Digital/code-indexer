/**
 * Fixed category tree: "All" + the 7 visual groups, each expandable to show
 * its member categories with per-category counts. Counts always read the
 * UNFILTERED asset list so they stay stable while a filter is active.
 * Collapse state persists per project (sprite-studio-ui-state).
 */
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronRight, Layers } from 'lucide-react';
import { cn } from '../../../lib/utils.js';
import { CATEGORY_GROUPS, type CategoryGroupId, type SpriteAsset } from '../types.js';
import { loadSpriteStudioUi, saveSpriteStudioUi } from '../sprite-studio-ui-state.js';

export function CategoryTree({
  projectId,
  assets,
  activeCategory,
  onCategory,
}: {
  projectId: number;
  assets: SpriteAsset[];
  activeCategory: CategoryGroupId | 'all';
  onCategory: (id: CategoryGroupId | 'all') => void;
}) {
  const { t } = useTranslation('spriteStudio');
  const [collapsed, setCollapsed] = useState<Set<string>>(
    () => new Set(loadSpriteStudioUi(projectId)?.collapsedGroups ?? []),
  );

  const byCategory = useMemo(() => {
    const m = new Map<string, number>();
    for (const a of assets) m.set(a.category, (m.get(a.category) ?? 0) + 1);
    return m;
  }, [assets]);

  const toggle = (id: CategoryGroupId) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      saveSpriteStudioUi(projectId, { collapsedGroups: [...next] });
      return next;
    });
  };

  const row = (active: boolean) => cn(
    'group flex h-6 w-full items-center gap-1 rounded px-1.5 text-[11px] transition-colors',
    active ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground',
  );

  return (
    <div className="space-y-px py-1">
      <button type="button" className={row(activeCategory === 'all')} onClick={() => onCategory('all')}>
        <Layers className="h-3 w-3 shrink-0" />
        <span className="min-w-0 flex-1 truncate text-left font-medium">{t('library.all')}</span>
        <span className="tabular-nums text-[10px] opacity-70">{assets.length}</span>
      </button>
      {CATEGORY_GROUPS.map((g) => {
        const count = g.categories.reduce((n, c) => n + (byCategory.get(c) ?? 0), 0);
        const open = !collapsed.has(g.id);
        return (
          <div key={g.id}>
            <div className={cn(row(activeCategory === g.id), 'cursor-pointer')} role="button" tabIndex={0}
              onClick={() => onCategory(g.id)}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onCategory(g.id); }}
            >
              <button
                type="button"
                aria-label={t(open ? 'library.collapseGroup' : 'library.expandGroup')}
                className="shrink-0 rounded p-px hover:bg-muted-foreground/10"
                onClick={(e) => { e.stopPropagation(); toggle(g.id); }}
              >
                {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
              </button>
              <span className="min-w-0 flex-1 truncate text-left font-medium">{t(g.labelKey)}</span>
              <span className="tabular-nums text-[10px] opacity-70">{count}</span>
            </div>
            {open && (
              <div className="ml-5 space-y-px">
                {g.categories.map((c) => (
                  <div key={c} className="flex h-5 items-center gap-1 px-1.5 text-[10px] text-muted-foreground/80">
                    <span className="min-w-0 flex-1 truncate">{t(`category.${c}`)}</span>
                    <span className="tabular-nums opacity-70">{byCategory.get(c) ?? 0}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
