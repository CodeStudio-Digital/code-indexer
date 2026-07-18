import { useTranslation } from 'react-i18next';
import { cn } from '../../../lib/utils.js';
import type { CategoryDef, SettingCategory } from './types.js';

/** Category rail (master-detail). Reuses the Admin left-rail look. */
export function SettingsSidebar({
  categories,
  counts,
  active,
  onSelect,
  total,
}: {
  categories: readonly CategoryDef[];
  counts: Map<SettingCategory, number>;
  active: SettingCategory | 'all';
  onSelect: (id: SettingCategory | 'all') => void;
  total: number;
}) {
  const { t } = useTranslation('settings');

  const row = (id: SettingCategory | 'all', label: string, count: number) => (
    <button
      key={id}
      type="button"
      onClick={() => onSelect(id)}
      aria-current={active === id ? 'page' : undefined}
      className={cn(
        'w-full text-left px-2.5 py-1.5 rounded-md text-sm flex items-center gap-2 transition-colors',
        active === id
          ? 'bg-accent text-accent-foreground font-medium'
          : 'text-muted-foreground hover:bg-muted/40',
      )}
    >
      <span className="truncate flex-1">{label}</span>
      <span className="text-[11px] tabular-nums text-muted-foreground">{count}</span>
    </button>
  );

  return (
    <nav className="w-52 shrink-0 space-y-0.5 sticky top-2 self-start">
      {row('all', t('chrome.allCategories'), total)}
      {categories.filter((c) => (counts.get(c.id) ?? 0) > 0).map((c) =>
        row(c.id, t(`category.${c.id}`, { defaultValue: c.label }), counts.get(c.id) ?? 0),
      )}
    </nav>
  );
}
