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
import type { useCompanyStream } from '../../../hooks/useCompanyStream.js';
import type { BoardMessage } from '../../../state/company/types.js';
import { WorkZone } from './work/WorkZone.js';
import { BuildZone } from './build/BuildZone.js';
import { DataZone } from './data/DataZone.js';
import { LeftTabRail } from './LeftTabRail.js';
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
  /** Bottom terminal panel open state — forwarded to the rail footer toggle. */
  terminalOpen: boolean;
  onToggleTerminal: () => void;
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
  terminalOpen,
  onToggleTerminal,
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

  return (
    // flex-1 inside the company-session view's flex-column center
    // (CompanySessionView). The bottom terminal panel lives below the
    // composer now (not wrapping ZoneLayout in a PanelGroup), so this
    // is the natural flex layout again.
    <div className="flex-1 flex overflow-hidden">
      <LeftTabRail
        activeZone={zone}
        activeTab={tab}
        onChange={handleChange}
        terminalOpen={terminalOpen}
        onToggleTerminal={onToggleTerminal}
      />
      <div className="flex-1 flex flex-col overflow-hidden">
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
  );
}
