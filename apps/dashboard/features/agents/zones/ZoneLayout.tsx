/**
 * Container for the company-mode content area.
 *
 * Layout: a vertical icon rail (`LeftTabRail`) on the left listing
 * every Work / Build / Data sub-tab, grouped by zone with a thin
 * separator between groups; the active tab's body fills the rest.
 * The old top-of-page tab strip (3 zone tabs + each zone's inner
 * TabsList) is gone — the rail is the single selector.
 *
 * Routing is unchanged: `:zone/:tab` from the URL still drives the
 * active selection; this component is purely presentational.
 */
import { useCallback } from 'react';
import { createPortal } from 'react-dom';
import type { useCompanyStream } from '../../../hooks/useCompanyStream.js';
import type { BoardMessage } from '../../../state/company/types.js';
import { WorkZone } from './work/WorkZone.js';
import { BuildZone } from './build/BuildZone.js';
import { DataZone } from './data/DataZone.js';
import { LeftTabRail } from './LeftTabRail.js';
import type { CompanySessionWorkbenchSlots } from '../company-workbench-slots.js';
import {
  DEFAULT_TAB_FOR_ZONE,
  isValidTab,
  type BuildTab,
  type DataTab,
  type WorkTab,
  type Zone,
} from './types.js';

interface ZoneLayoutProps {
  sessionId: number;
  sessionName: string;
  zone: Zone;
  tab: string;
  onZoneTabChange: (zone: Zone, tab: string) => void;
  stream: ReturnType<typeof useCompanyStream>;
  boardMessages: BoardMessage[];
  /**
   * Master composer slot — rendered inside WorkZone's Board tab only.
   * Passed through here so CompanySessionView can keep ownership of
   * the composer's closures without WorkZone re-wiring them.
   */
  composer?: React.ReactNode;
  /** Bottom panel open state — forwarded to the rail footer toggle. */
  bottomOpen: boolean;
  onToggleBottom: () => void;
  workbenchSlots?: CompanySessionWorkbenchSlots;
}

export function ZoneLayout({
  sessionId,
  sessionName,
  zone,
  tab,
  onZoneTabChange,
  stream,
  boardMessages,
  composer,
  bottomOpen,
  onToggleBottom,
  workbenchSlots,
}: ZoneLayoutProps) {
  const handleChange = useCallback(
    (nextZone: Zone, nextTab: string) => {
      const finalTab = isValidTab(nextZone, nextTab)
        ? nextTab
        : DEFAULT_TAB_FOR_ZONE[nextZone];
      onZoneTabChange(nextZone, finalTab);
    },
    [onZoneTabChange],
  );

  const rail = (
    <LeftTabRail
      activeZone={zone}
      activeTab={tab}
      onChange={handleChange}
      bottomOpen={bottomOpen}
      onToggleBottom={onToggleBottom}
      catalog={workbenchSlots?.catalog}
    />
  );

  return (
    <>
      {workbenchSlots
        ? (workbenchSlots.leftRailHost && createPortal(rail, workbenchSlots.leftRailHost))
        : rail}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {zone === 'work' && (
          <WorkZone
            sessionId={sessionId}
            sessionName={sessionName}
            tab={(isValidTab('work', tab) ? tab : DEFAULT_TAB_FOR_ZONE.work) as WorkTab}
            stream={stream}
            boardMessages={boardMessages}
            composer={composer}
          />
        )}
        {zone === 'build' && (
          <BuildZone
            sessionId={sessionId}
            tab={(isValidTab('build', tab) ? tab : DEFAULT_TAB_FOR_ZONE.build) as BuildTab}
          />
        )}
        {zone === 'data' && (
          <DataZone
            sessionId={sessionId}
            tab={(isValidTab('data', tab) ? tab : DEFAULT_TAB_FOR_ZONE.data) as DataTab}
          />
        )}
        </div>
      </div>
    </>
  );
}
