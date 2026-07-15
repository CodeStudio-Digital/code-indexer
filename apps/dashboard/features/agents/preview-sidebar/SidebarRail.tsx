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
 * Buttons / edge / separators come from the shared `components/chrome`
 * rail primitives, so this reads identically to the ProjectView rail —
 * the selection bar just hugs the right (inner) edge.
 */
import { useEffect, useState } from 'react';
import { Building2, ChevronDown, ChevronUp, Database, Inbox, KeyRound, Puzzle, ShieldOff } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { RailButton, RailContainer, RailSeparator } from '../../../components/chrome/index.js';
import type { ContribToolWindow } from '../../../state/contribution-registry.js';

export type SidePanel =
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
  /** Contributed tool windows → extra rail icons opening their webview. */
  pluginWindows?: ContribToolWindow[];
}

interface RailIcon {
  id: SidePanel;
  Icon: typeof Building2;
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

export function SidebarRail({ active, onToggle, pluginWindows = [] }: SidebarRailProps) {
  const { t } = useTranslation('agents');
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
    ...BASE_ICONS,
    ...pluginIcons,
  ];
  const core = icons.filter((i) => !i.advanced);
  const advanced = icons.filter((i) => i.advanced);
  // A panel opened via persisted state / deep link keeps its group visible.
  const showAdvanced = expanded || advanced.some((i) => i.id === active);

  const renderIcon = ({ id, Icon, title }: RailIcon): React.ReactNode => (
    <RailButton
      key={id}
      icon={Icon}
      label={title}
      active={active === id}
      side="right"
      role="toggle"
      onClick={() => onToggle(id)}
    />
  );

  return (
    <RailContainer side="right" aria-label={t('company.rightRailLabel')}>
      {core.map(renderIcon)}
      <RailSeparator />
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        title={t('company.moreTabs')}
        aria-label={t('company.moreTabs')}
        aria-expanded={showAdvanced}
        className="h-8 w-8 grid place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        {showAdvanced ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
      </button>
      {showAdvanced && advanced.map(renderIcon)}
    </RailContainer>
  );
}
