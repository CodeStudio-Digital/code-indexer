/**
 * Vertical activity rail on the RIGHT of an open coder session — the
 * counterpart to the VS Code activity bar. Each icon either toggles a
 * panel (Skills, Tools, Metrics, etc.) or fires a one-shot action
 * (Snapshots opens a modal directly).
 *
 * Layout: 40px width, sticky to the viewport right. Active icon shows a
 * primary-colored vertical bar on the inner edge — same indicator pattern
 * as the left `ProjectRail` in `ProjectView`, so the visual language is
 * consistent across rails.
 */
import { useTranslation } from 'react-i18next';
import {
  BarChart3,
  Compass,
  Gauge,
  GitCompare,
  HardDrive,
  Info,
  ScrollText,
  Settings,
  type LucideIcon,
} from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '../../../components/ui/tooltip.js';
import { cn } from '../../../lib/utils.js';
import { pluginWindowIcon } from '../../workspace/plugin-icon.js';
import type { ContribToolWindow } from '../../../state/contribution-registry.js';
import type { RightPanelId } from './types.js';

interface RailEntry {
  id: RightPanelId | 'snapshots';
  icon: LucideIcon;
  /** i18n key under `chat:` — built-in entries. */
  labelKey?: string;
  /** Literal label — plugin entries (title comes from the manifest). */
  label?: string;
  /** Snapshots is special: clicking opens a modal, not a panel. */
  kind: 'panel' | 'modal';
  /** Optional badge count — Snapshots uses it for pending hunks. */
  badge?: number;
}

interface ChatRightRailProps {
  activePanelId: RightPanelId | null;
  onSelectPanel: (id: RightPanelId | null) => void;
  /** Fired when the user clicks the Snapshots icon. Optional. */
  onOpenSnapshots?: () => void;
  /** Pending snapshot count for the Snapshots badge. */
  pendingSnapshots?: number;
  /** Plugin tool windows (side: 'right') — one rail icon each. */
  pluginWindows?: ContribToolWindow[];
}

export function ChatRightRail({
  activePanelId,
  onSelectPanel,
  onOpenSnapshots,
  pendingSnapshots,
  pluginWindows = [],
}: ChatRightRailProps) {
  const { t } = useTranslation(['chat']);

  const pluginEntries: RailEntry[] = pluginWindows
    .filter((w) => w.side === 'right')
    .map((w) => ({
      id: `plugin:${w.pluginNs}:${w.id}` as RightPanelId,
      icon: pluginWindowIcon(w.icon),
      label: w.title,
      kind: 'panel' as const,
    }));

  // Grouped by purpose so the rail reads as intentional, not a flat dump:
  // context (what the agent is working with) → inspection (observe the run)
  // → plugins → a bottom-pinned Configuration cog (Skills + Tools tabs).
  const contextEntries: RailEntry[] = [
    { id: 'meta', icon: Compass, labelKey: 'rightRail.meta', kind: 'panel' },
    { id: 'drive', icon: HardDrive, labelKey: 'rightRail.drive', kind: 'panel' },
  ];

  const inspectEntries: RailEntry[] = [
    { id: 'metrics', icon: Gauge, labelKey: 'rightRail.metrics', kind: 'panel' },
    { id: 'details', icon: Info, labelKey: 'rightRail.details', kind: 'panel' },
    { id: 'tool-stats', icon: BarChart3, labelKey: 'rightRail.toolStats', kind: 'panel' },
    { id: 'worker-log', icon: ScrollText, labelKey: 'rightRail.workerLog', kind: 'panel' },
    {
      id: 'snapshots',
      icon: GitCompare,
      labelKey: 'rightRail.snapshots',
      kind: 'modal',
      badge: pendingSnapshots,
    },
  ];

  // Skills + Tools collapsed into one bottom-pinned cog (VS Code "Manage" pattern).
  const configEntry: RailEntry = {
    id: 'config',
    icon: Settings,
    labelKey: 'rightRail.config',
    kind: 'panel',
  };

  const renderEntry = (entry: RailEntry) => {
    const Icon = entry.icon;
    const active = entry.kind === 'panel' && activePanelId === entry.id;
    const label = entry.label ?? t(`chat:${entry.labelKey}`, entry.id);
    const handleClick = () => {
      if (entry.kind === 'modal') {
        if (entry.id === 'snapshots') onOpenSnapshots?.();
        return;
      }
      // Toggle: clicking the active panel closes it.
      onSelectPanel(active ? null : (entry.id as RightPanelId));
    };
    return (
      <Tooltip key={entry.id}>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={handleClick}
            aria-label={label}
            aria-pressed={active}
            className={cn(
              'relative h-8 w-8 grid place-items-center rounded-md transition-colors',
              active
                ? 'bg-accent text-accent-foreground'
                : 'text-muted-foreground hover:bg-muted hover:text-foreground',
            )}
          >
            <Icon className="h-4 w-4" />
            {active && (
              <span
                aria-hidden
                className="absolute -right-1 top-1.5 bottom-1.5 w-0.5 rounded-full bg-primary"
              />
            )}
            {entry.badge != null && entry.badge > 0 && (
              <span className="absolute -top-0.5 -right-0.5 min-w-[14px] h-3.5 px-1 rounded-full bg-primary text-primary-foreground text-[8px] font-medium flex items-center justify-center tabular-nums">
                {entry.badge > 99 ? '99+' : entry.badge}
              </span>
            )}
          </button>
        </TooltipTrigger>
        <TooltipContent side="left">{label}</TooltipContent>
      </Tooltip>
    );
  };

  return (
    <nav
      className="flex flex-col w-10 shrink-0 border-l bg-card/40 py-1 gap-0.5 items-center"
      aria-label="Session tools"
    >
      {contextEntries.map(renderEntry)}
      <RailDivider />
      {inspectEntries.map(renderEntry)}
      {pluginEntries.length > 0 && <RailDivider />}
      {pluginEntries.map(renderEntry)}
      <div className="mt-auto flex flex-col items-center gap-0.5 pt-1">
        <RailDivider />
        {renderEntry(configEntry)}
      </div>
    </nav>
  );
}

/** Thin horizontal rule between rail groups — mirrors the left `ProjectRail`. */
function RailDivider() {
  return <span aria-hidden className="h-px w-6 bg-border my-1" />;
}
