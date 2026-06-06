/**
 * Derives the visible setting list from the active category + search query +
 * advanced toggle, plus per-category counts for the sidebar. Search is
 * accent-insensitive and spans the variable key, the translated label and the
 * translated description. A non-empty query goes flat (cross-category).
 */
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { SettingCategory, SettingItem } from './types.js';

const norm = (s: string): string => s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();

export interface FilterArgs {
  items: SettingItem[];
  activeCategory: SettingCategory | 'all';
  query: string;
  showAdvanced: boolean;
}

export function useSettingsFilter({ items, activeCategory, query, showAdvanced }: FilterArgs) {
  const { t } = useTranslation('settings');
  return useMemo(() => {
    const q = norm(query.trim());
    const labelOf = (i: SettingItem): string => t(`item.${i.key}.label`, { defaultValue: i.label });
    const descOf = (i: SettingItem): string => t(`item.${i.key}.description`, { defaultValue: i.description });

    const afterAdvanced = items.filter((i) => showAdvanced || !i.advanced);
    const counts = new Map<SettingCategory, number>();
    for (const i of afterAdvanced) counts.set(i.category, (counts.get(i.category) ?? 0) + 1);

    const matchesQuery = (i: SettingItem): boolean =>
      !q || norm(i.key).includes(q) || norm(labelOf(i)).includes(q) || norm(descOf(i)).includes(q);

    const visible = afterAdvanced.filter(
      (i) => (q || activeCategory === 'all' || i.category === activeCategory) && matchesQuery(i),
    );

    return {
      visible,
      counts,
      searching: q.length > 0,
      essentialsCount: items.filter((i) => !i.advanced).length,
      advancedCount: items.filter((i) => i.advanced).length,
    };
  }, [items, activeCategory, query, showAdvanced, t]);
}
