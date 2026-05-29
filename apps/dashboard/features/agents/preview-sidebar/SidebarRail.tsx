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
import { Building2, Database, Inbox, KeyRound, Monitor, Puzzle, ShieldOff } from 'lucide-react';
import { cn } from '../../../lib/utils.js';
import type { ContribToolWindow } from '../../../state/contribution-registry.js';

export type SidePanel =
  | 'preview'
  | 'inbox'
  | 'env'
  | 'databases'
  | 'company-config'
  | 'supervisor'
  // Plugin-contributed tool windows: `plugin:<namespace>:<windowId>`.
  | `plugin:${string}`;

interface SidebarRailProps {
  active: SidePanel | null;
  onToggle: (panel: SidePanel) => void;
  /** Hide the Preview icon when the session has no builder sandbox. */
  showPreview: boolean;
  /** Contributed tool windows → extra rail icons opening their webview. */
  pluginWindows?: ContribToolWindow[];
}

interface RailIcon {
  id: SidePanel;
  Icon: typeof Monitor;
  title: string;
}

// `company-config` lives at the top because it's the highest-level
// context (roles + projects + agents) — operators glance here first
// when joining a session. `supervisor` is right below because when an
// agent gets stuck it's the operator's primary actionable surface.
// Inbox/Env/Databases are operational peeks.
const BASE_ICONS: RailIcon[] = [
  { id: 'company-config', Icon: Building2, title: 'Configuração da Empresa' },
  { id: 'supervisor', Icon: ShieldOff, title: 'Agent Supervisor' },
  { id: 'inbox', Icon: Inbox, title: 'Inbox' },
  { id: 'env', Icon: KeyRound, title: 'Env' },
  { id: 'databases', Icon: Database, title: 'Databases' },
];

export function SidebarRail({ active, onToggle, showPreview, pluginWindows = [] }: SidebarRailProps) {
  const pluginIcons: RailIcon[] = pluginWindows.map((w) => ({
    id: `plugin:${w.pluginNs}:${w.id}` as SidePanel,
    Icon: Puzzle,
    title: w.title,
  }));
  const icons: RailIcon[] = [
    ...(showPreview ? [{ id: 'preview' as SidePanel, Icon: Monitor, title: 'Preview' }] : []),
    ...BASE_ICONS,
    ...pluginIcons,
  ];

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
