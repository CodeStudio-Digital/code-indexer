/**
 * Data zone: per-session persistence surfaces.
 *
 *   - Drive      -> shared session file store.
 *   - Snapshots  -> session-level snapshots for restore/rollback.
 *   - Archived   -> archived board/agents from prior runs.
 *
 * Per-project index/search live in the project view (Files / Search) --
 * they were duplicated here and removed. Env and Databases live in the
 * right-side drawer (`preview-sidebar/SidebarRail`).
 */
import { DrivePanel } from '../../DrivePanel.js';
import { SnapshotsPanel } from '../../../snapshots/SnapshotsPanel.js';
import { ArchivedTab } from '../../ArchivedTab.js';
import type { DataTab } from '../types.js';

interface DataZoneProps {
  sessionId: string;
  tab: DataTab;
}

export function DataZone({ sessionId, tab }: DataZoneProps) {
  if (tab === 'drive') return <DrivePanel companySessionId={sessionId} />;
  if (tab === 'snapshots') return <SnapshotsPanel scope="company" sessionId={sessionId} />;
  return <ArchivedTab companySessionId={sessionId} />;
}
