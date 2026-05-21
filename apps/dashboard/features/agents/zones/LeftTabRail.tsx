/**
 * Vertical icon rail at the left edge of the agents content area.
 *
 * Replaces the old Work/Build/Data top tab strip + each zone's inner
 * `TabsList`. Icons are sourced from `TAB_REGISTRY` and grouped by
 * zone with a thin separator between groups, so the user can still
 * see "this lives in Build" at a glance.
 *
 * Clicking an icon calls `onChange(zone, tab)`; the parent owns the
 * router navigation. Active state is purely visual.
 */
import { useTranslation } from 'react-i18next';
import { cn } from '../../../lib/utils.js';
import { TAB_REGISTRY } from './tab-registry.js';
import type { Zone } from './types.js';

interface LeftTabRailProps {
  activeZone: Zone;
  activeTab: string;
  onChange: (zone: Zone, tab: string) => void;
}

export function LeftTabRail({ activeZone, activeTab, onChange }: LeftTabRailProps) {
  const { t } = useTranslation('agents');

  // Track the previous zone so we can insert a separator between
  // groups. `prevZone` is mutated locally inside the map — fine here
  // because the result of `.map(...)` is consumed immediately.
  let prevZone: Zone | null = null;

  return (
    <div className="w-10 border-r flex flex-col items-center gap-1 py-2 bg-card flex-shrink-0 overflow-y-auto">
      {TAB_REGISTRY.map((td) => {
        const showSep = prevZone !== null && prevZone !== td.zone;
        prevZone = td.zone;
        const isActive = activeZone === td.zone && activeTab === td.tab;
        const label = t(td.labelKey, { defaultValue: td.fallbackLabel });
        const key = `${td.zone}-${td.tab}`;
        return (
          <div key={key} className="flex flex-col items-center gap-1 w-full">
            {showSep && <div className="w-6 border-t" />}
            <button
              type="button"
              onClick={() => onChange(td.zone, td.tab)}
              title={label}
              aria-label={label}
              className={cn(
                'p-1.5 rounded-md transition-colors',
                isActive
                  ? 'bg-muted text-foreground'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground',
              )}
            >
              <td.Icon className="h-4 w-4" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
