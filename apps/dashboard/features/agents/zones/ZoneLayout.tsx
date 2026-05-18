/**
 * Outer 3-tab shell (Work / Build / Data) for the company-mode view.
 *
 * The zone selector is rendered as a prominent tab strip. Each zone owns
 * its own inner tab list and content. Switching zones falls back to the
 * zone's `DEFAULT_TAB_FOR_ZONE` so the user never lands on an undefined
 * inner tab.
 *
 * Phase 1 owns state in the parent. Phase 1b will read both `zone` and
 * `tab` from the URL via `useParams`.
 */
import { useCallback } from 'react';
import { Briefcase, Database, Hammer } from 'lucide-react';
import { Tabs, TabsList, TabsTrigger } from '../../../components/ui/tabs.js';
import type { useCompanyStream } from '../../../hooks/useCompanyStream.js';
import type { BoardMessage } from '../../../state/company/types.js';
import { WorkZone } from './work/WorkZone.js';
import { BuildZone } from './build/BuildZone.js';
import { DataZone } from './data/DataZone.js';
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
}

export function ZoneLayout({
  sessionId,
  sessionName,
  zone,
  tab,
  onZoneTabChange,
  stream,
  boardMessages,
}: ZoneLayoutProps) {
  const handleZoneChange = useCallback(
    (next: string) => {
      const z = next as Zone;
      const stillValid = isValidTab(z, tab);
      onZoneTabChange(z, stillValid ? tab : DEFAULT_TAB_FOR_ZONE[z]);
    },
    [tab, onZoneTabChange],
  );

  const handleTabChange = useCallback(
    (next: WorkTab | BuildTab | DataTab) => {
      onZoneTabChange(zone, next);
    },
    [zone, onZoneTabChange],
  );

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <Tabs
        value={zone}
        onValueChange={handleZoneChange}
        className="flex-shrink-0"
      >
        <TabsList className="mx-3 mt-2 w-fit">
          <TabsTrigger value="work" className="text-xs gap-1.5 px-3">
            <Briefcase className="h-3.5 w-3.5" /> Work
          </TabsTrigger>
          <TabsTrigger value="build" className="text-xs gap-1.5 px-3">
            <Hammer className="h-3.5 w-3.5" /> Build
          </TabsTrigger>
          <TabsTrigger value="data" className="text-xs gap-1.5 px-3">
            <Database className="h-3.5 w-3.5" /> Data
          </TabsTrigger>
        </TabsList>
      </Tabs>

      {zone === 'work' && (
        <WorkZone
          sessionId={sessionId}
          sessionName={sessionName}
          tab={(isValidTab('work', tab) ? tab : DEFAULT_TAB_FOR_ZONE.work) as WorkTab}
          onTabChange={handleTabChange}
          stream={stream}
          boardMessages={boardMessages}
        />
      )}
      {zone === 'build' && (
        <BuildZone
          sessionId={sessionId}
          tab={(isValidTab('build', tab) ? tab : DEFAULT_TAB_FOR_ZONE.build) as BuildTab}
          onTabChange={handleTabChange}
        />
      )}
      {zone === 'data' && (
        <DataZone
          sessionId={sessionId}
          tab={(isValidTab('data', tab) ? tab : DEFAULT_TAB_FOR_ZONE.data) as DataTab}
          onTabChange={handleTabChange}
        />
      )}
    </div>
  );
}
