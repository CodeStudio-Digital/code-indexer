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
import { useEffect, useState } from 'react';
import { Building2, ChevronDown, ChevronUp, Database, Inbox, KeyRound, Monitor, Puzzle, ShieldOff } from 'lucide-react';
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
  /** Collapsed into the "More" group by default (mirrors LeftTabRail). */
  advanced?: boolean;
}

// `company-config` lives at the top because it's the highest-level
// context (roles + projects + agents) — operators glance here first
// when joining a session. Inbox/Env are operational peeks. Supervisor
// and Databases are advanced: valuable when needed, noise otherwise.
const BASE_ICONS: RailIcon[] = [
  { id: 'company-config', Icon: Building2, title: 'Configuração da Empresa' },
  { id: 'inbox', Icon: Inbox, title: 'Inbox' },
  { id: 'env', Icon: KeyRound, title: 'Env' },
  { id: 'supervisor', Icon: ShieldOff, title: 'Agent Supervisor', advanced: true },
  { id: 'databases', Icon: Database, title: 'Databases', advanced: true },
];

const ADVANCED_STORAGE_KEY = 'agents.sidebarRailAdvanced';

function readStoredAdvanced(): boolean {
  try {
    return localStorage.getItem(ADVANCED_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

export function SidebarRail({ active, onToggle, showPreview, pluginWindows = [] }: SidebarRailProps) {
  const [expanded, setExpanded] = useState(readStoredAdvanced);
  useEffect(() => {
    try {
      localStorage.setItem(ADVANCED_STORAGE_KEY, expanded ? '1' : '0');
    } catch {
      /* private mode — non-persistent toggle still works */
    }
  }, [expanded]);

  // Honor the author's declared `side`: this is the Company session's RIGHT
  // drawer, so only windows that asked for `side: 'right'` surface here.
  // `left`/`right` also show in the Project rail; `bottom` belongs to the
  // bottom panel — neither of those leaks into this drawer.
  const pluginIcons: RailIcon[] = pluginWindows
    .filter((w) => w.side === 'right')
    .map((w) => ({
      id: `plugin:${w.pluginNs}:${w.id}` as SidePanel,
      Icon: Puzzle,
      title: w.title,
    }));
  const icons: RailIcon[] = [
    ...(showPreview ? [{ id: 'preview' as SidePanel, Icon: Monitor, title: 'Preview' }] : []),
    ...BASE_ICONS,
    ...pluginIcons,
  ];
  const core = icons.filter((i) => !i.advanced);
  const advanced = icons.filter((i) => i.advanced);
  // A panel opened via persisted state / deep link keeps its group visible.
  const showAdvanced = expanded || advanced.some((i) => i.id === active);

  const renderIcon = ({ id, Icon, title }: RailIcon): React.ReactNode => {
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
  };

  return (
    <div className="w-10 border-l flex flex-col items-center gap-1 py-2 bg-card flex-shrink-0">
      {core.map(renderIcon)}
      <div className="w-6 border-t" />
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        title="More"
        aria-expanded={showAdvanced}
        className="p-1.5 rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        {showAdvanced ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
      </button>
      {showAdvanced && advanced.map(renderIcon)}
    </div>
  );
}
