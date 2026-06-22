/**
 * Left rail for the Settings shell (IDE-style). Renders a search box that
 * filters sections (accent-insensitive) and a collapsible group tree. When
 * a query is present the tree flattens to a single matching list (group
 * headers hidden), mirroring the app-settings filter behavior. The active
 * section's group is always expanded so the current row can't hide.
 *
 * The section/group registry lives in `Admin.tsx` (it captures `t` and the
 * providers handlers); this component is purely presentational + owns its
 * own search/collapse UI state.
 */
import { Fragment, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronRight, Search } from 'lucide-react';
import { cn } from '../../lib/utils.js';
import { norm } from '../../lib/normalize.js';
import type { GroupDef, GroupId, SectionDef, SectionId } from './settings-types.js';

interface SettingsRailProps {
  sections: SectionDef[];
  groups: GroupDef[];
  activeId: SectionId;
  onSelect: (id: SectionId) => void;
}

export function SettingsRail({ sections, groups, activeId, onSelect }: SettingsRailProps) {
  const { t } = useTranslation(['admin']);
  const [query, setQuery] = useState('');
  const [collapsed, setCollapsed] = useState<Set<GroupId>>(() => new Set());

  const activeGroup = sections.find((s) => s.id === activeId)?.group;
  // The active section's group is force-expanded (derived, no effect) so the
  // current row is always visible even if the user collapsed that group.
  const isExpanded = (g: GroupId): boolean => !collapsed.has(g) || g === activeGroup;
  const toggleGroup = (g: GroupId): void =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      next.has(g) ? next.delete(g) : next.add(g);
      return next;
    });

  const nq = norm(query.trim());
  const searching = nq.length > 0;
  const matches = (s: SectionDef): boolean =>
    !nq || norm(s.label).includes(nq) || norm(s.hint ?? '').includes(nq);

  const renderRow = (def: SectionDef) => {
    const Icon = def.icon;
    const isActive = activeId === def.id;
    return (
      <button
        key={def.id}
        type="button"
        onClick={() => onSelect(def.id)}
        aria-current={isActive ? 'page' : undefined}
        title={def.hint}
        className={cn(
          'relative text-left rounded-sm px-2 py-1.5 transition-colors flex items-center gap-2',
          isActive
            ? 'bg-accent text-accent-foreground'
            : 'text-muted-foreground hover:text-foreground hover:bg-muted',
        )}
      >
        {/* Active accent bar — flush against the rail edge. */}
        {isActive && (
          <span
            aria-hidden
            className="absolute left-0 top-1.5 bottom-1.5 w-0.5 rounded-r bg-primary"
          />
        )}
        <Icon
          className={cn(
            'h-3.5 w-3.5 shrink-0',
            isActive ? 'text-primary' : 'text-muted-foreground/70',
          )}
        />
        <span
          className={cn(
            'min-w-0 flex-1 truncate text-[12.5px] font-medium',
            isActive ? 'text-foreground' : '',
          )}
        >
          {def.label}
        </span>
      </button>
    );
  };

  const filtered = searching ? sections.filter(matches) : [];

  return (
    <div className="flex flex-col gap-2">
      {/* Search — filters sections by label/hint; flattens the tree. */}
      <div className="relative px-1 pt-1">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground/60" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('admin:rail.searchPlaceholder')}
          className="w-full h-8 rounded-md border border-input bg-background pl-8 pr-2 text-[12.5px] placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        />
      </div>

      <nav aria-label={t('admin:rail.sectionsLabel')} className="flex flex-col gap-0.5 px-1 pb-1">
        {searching ? (
          filtered.length === 0 ? (
            <div className="px-2 py-3 text-[11.5px] text-muted-foreground">
              {t('admin:rail.noResults')}
            </div>
          ) : (
            filtered.map(renderRow)
          )
        ) : (
          groups.map((g) => {
            const expanded = isExpanded(g.id);
            return (
              <Fragment key={g.id}>
                <button
                  type="button"
                  onClick={() => toggleGroup(g.id)}
                  aria-expanded={expanded}
                  className="mt-1 first:mt-0 flex items-center gap-1 px-1.5 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60 hover:text-muted-foreground transition-colors"
                >
                  {expanded ? (
                    <ChevronDown className="h-3 w-3 shrink-0" />
                  ) : (
                    <ChevronRight className="h-3 w-3 shrink-0" />
                  )}
                  <span className="truncate">{g.label}</span>
                </button>
                {expanded && sections.filter((s) => s.group === g.id).map(renderRow)}
              </Fragment>
            );
          })
        )}
      </nav>
    </div>
  );
}
