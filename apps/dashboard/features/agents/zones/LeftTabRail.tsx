/**
 * Vertical icon rail at the left edge of the agents content area.
 *
 * Replaces the old Work/Build/Data top tab strip + each zone's inner
 * `TabsList`. Icons are sourced from `TAB_REGISTRY` and grouped by
 * zone with a thin separator between groups, so the user can still
 * see "this lives in Build" at a glance.
 *
 * Tabs flagged `advanced` collapse into a "More" group behind a chevron
 * at the bottom. The expanded state persists in localStorage and the
 * group AUTO-EXPANDS whenever the active tab lives inside it — deep
 * links to demoted tabs keep working and stay visible.
 *
 * Clicking an icon calls `onChange(zone, tab)`; the parent owns the
 * router navigation. Active state is purely visual.
 *
 * The buttons / edge / separators come from the shared `components/chrome`
 * rail primitives (same as the ProjectView rail), and the terminal toggle
 * is pinned to the footer (`mt-auto`) mirroring that rail.
 */
import { Fragment, useEffect, useState } from 'react';
import { ChevronDown, ChevronUp, LayoutTemplate, TerminalSquare, Users } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { RailButton, RailContainer, RailSeparator } from '../../../components/chrome/index.js';
import { TAB_REGISTRY, type TabDef } from './tab-registry.js';
import type { Zone } from './types.js';
import type { CompanyCatalogRail } from '../company-workbench-slots.js';

interface LeftTabRailProps {
  activeZone: Zone;
  activeTab: string;
  onChange: (zone: Zone, tab: string) => void;
  /** Bottom panel open state — drives the footer toggle. */
  bottomOpen: boolean;
  onToggleBottom: () => void;
  catalog?: CompanyCatalogRail;
}

const ADVANCED_STORAGE_KEY = 'agents.railAdvanced';

function readStoredAdvanced(): boolean {
  try {
    return localStorage.getItem(ADVANCED_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

export function LeftTabRail({ activeZone, activeTab, onChange, bottomOpen, onToggleBottom, catalog }: LeftTabRailProps) {
  const { t } = useTranslation('agents');
  const [expanded, setExpanded] = useState(readStoredAdvanced);

  const core = TAB_REGISTRY.filter((td) => !td.advanced);
  const advanced = TAB_REGISTRY.filter((td) => td.advanced);
  const activeIsAdvanced = advanced.some((td) => td.zone === activeZone && td.tab === activeTab);
  // Deep link / restored route into a demoted tab → keep the group open.
  const showAdvanced = expanded || activeIsAdvanced;

  useEffect(() => {
    try {
      localStorage.setItem(ADVANCED_STORAGE_KEY, expanded ? '1' : '0');
    } catch {
      /* private mode — non-persistent toggle still works */
    }
  }, [expanded]);

  // Track the previous zone so we can insert a separator between
  // groups. `prevZone` is mutated locally inside the map — fine here
  // because the result of `.map(...)` is consumed immediately.
  let prevZone: Zone | null = null;

  const renderIcon = (td: TabDef): React.ReactNode => {
    const showSep = prevZone !== null && prevZone !== td.zone;
    prevZone = td.zone;
    const isActive = activeZone === td.zone && activeTab === td.tab;
    const label = t(td.labelKey, { defaultValue: td.fallbackLabel });
    const key = `${td.zone}-${td.tab}`;
    return (
      <Fragment key={key}>
        {showSep && <RailSeparator />}
        <RailButton
          icon={td.Icon}
          label={label}
          active={isActive}
          onClick={() => onChange(td.zone, td.tab)}
        />
      </Fragment>
    );
  };

  const renderGroup = (list: readonly TabDef[]): React.ReactNode[] => {
    prevZone = null;
    return list.map(renderIcon);
  };

  const moreLabel = t('company.moreTabs', { defaultValue: 'More' });
  const terminalLabel = t('company.terminal', { defaultValue: 'Terminal' });

  return (
    <RailContainer side="left" aria-label={t('company.leftRailLabel')}>
      {renderGroup(core)}
      <RailSeparator />
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        title={moreLabel}
        aria-label={moreLabel}
        aria-expanded={showAdvanced}
        className="h-8 w-8 grid place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        {showAdvanced ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
      </button>
      {showAdvanced && renderGroup(advanced)}
      {/* Terminal toggle pinned to the footer — mirrors the ProjectView rail. */}
      <div className="mt-auto pb-1 flex flex-col items-center gap-0.5">
        <RailButton
          icon={TerminalSquare}
          label={terminalLabel}
          role="toggle"
          active={bottomOpen}
          onClick={onToggleBottom}
        />
        {catalog && (
          <>
            <RailSeparator />
            <RailButton
              icon={Users}
              label={t('sessions')}
              role="toggle"
              active={catalog.open && catalog.activeView === 'sessions'}
              onClick={() => catalog.onToggle('sessions')}
              badge={catalog.sessionCount}
            />
            <RailButton
              icon={LayoutTemplate}
              label={t('templates')}
              role="toggle"
              active={catalog.open && catalog.activeView === 'templates'}
              onClick={() => catalog.onToggle('templates')}
              badge={catalog.templateCount}
            />
          </>
        )}
      </div>
    </RailContainer>
  );
}
