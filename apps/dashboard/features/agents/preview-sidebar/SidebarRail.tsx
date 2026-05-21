/**
 * Vertical icon rail at the right edge of the agents view.
 *
 * Each icon toggles its companion drawer (`SidebarPanels` content):
 * clicking the active one collapses; clicking another swaps.
 *
 * Items live here when the user typically wants them ALONGSIDE the
 * central tab rather than INSTEAD of it. Files / Git / API Reference
 * moved to the left rail because they're "what am I editing"; Inbox /
 * Env / Databases came over because they're peek-while-working.
 *
 * Preview is the only icon gated on `builderMode` — the others work
 * against per-session data regardless of sandbox state.
 */
import { Database, Inbox, KeyRound, Monitor } from 'lucide-react';
import { cn } from '../../../lib/utils.js';

export type SidePanel = 'preview' | 'inbox' | 'env' | 'databases';

interface SidebarRailProps {
  active: SidePanel | null;
  onToggle: (panel: SidePanel) => void;
  /** Hide the Preview icon when the session has no builder sandbox. */
  showPreview: boolean;
}

interface RailIcon {
  id: SidePanel;
  Icon: typeof Monitor;
  title: string;
}

const BASE_ICONS: RailIcon[] = [
  { id: 'inbox', Icon: Inbox, title: 'Inbox' },
  { id: 'env', Icon: KeyRound, title: 'Env' },
  { id: 'databases', Icon: Database, title: 'Databases' },
];

export function SidebarRail({ active, onToggle, showPreview }: SidebarRailProps) {
  const icons: RailIcon[] = showPreview
    ? [{ id: 'preview', Icon: Monitor, title: 'Preview' }, ...BASE_ICONS]
    : BASE_ICONS;

  return (
    <div className="w-10 border-l flex flex-col items-center gap-1 py-2 bg-card flex-shrink-0">
      {icons.map(({ id, Icon, title }) => {
        const isActive = active === id;
        return (
          <button
            key={id}
            type="button"
            onClick={() => onToggle(id)}
            title={title}
            className={cn(
              'p-1.5 rounded-md transition-colors',
              isActive
                ? 'bg-muted text-foreground'
                : 'text-muted-foreground hover:bg-muted hover:text-foreground',
            )}
          >
            <Icon className="h-4 w-4" />
          </button>
        );
      })}
    </div>
  );
}
