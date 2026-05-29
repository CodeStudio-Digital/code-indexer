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
  Info,
  ScrollText,
  Sparkles,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '../../../components/ui/tooltip.js';
import { cn } from '../../../lib/utils.js';
import type { RightPanelId } from './types.js';

interface RailEntry {
  id: RightPanelId | 'snapshots';
  icon: LucideIcon;
  labelKey: string;
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
}

export function ChatRightRail({
  activePanelId,
  onSelectPanel,
  onOpenSnapshots,
  pendingSnapshots,
}: ChatRightRailProps) {
  const { t } = useTranslation(['chat']);

  const entries: RailEntry[] = [
    { id: 'meta', icon: Compass, labelKey: 'rightRail.meta', kind: 'panel' },
    { id: 'skills', icon: Sparkles, labelKey: 'rightRail.skills', kind: 'panel' },
    { id: 'tools', icon: Wrench, labelKey: 'rightRail.tools', kind: 'panel' },
    { id: 'metrics', icon: Gauge, labelKey: 'rightRail.metrics', kind: 'panel' },
    { id: 'tool-stats', icon: BarChart3, labelKey: 'rightRail.toolStats', kind: 'panel' },
    { id: 'worker-log', icon: ScrollText, labelKey: 'rightRail.workerLog', kind: 'panel' },
    { id: 'details', icon: Info, labelKey: 'rightRail.details', kind: 'panel' },
    {
      id: 'snapshots',
      icon: GitCompare,
      labelKey: 'rightRail.snapshots',
      kind: 'modal',
      badge: pendingSnapshots,
    },
  ];

  return (
    <nav
      className="flex flex-col w-10 shrink-0 border-l bg-card/40 py-1 gap-0.5 items-center"
      aria-label="Session tools"
    >
      {entries.map((entry) => {
        const Icon = entry.icon;
        const active = entry.kind === 'panel' && activePanelId === entry.id;
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
                aria-label={t(`chat:${entry.labelKey}`, entry.id)}
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
            <TooltipContent side="left">
              {t(`chat:${entry.labelKey}`, entry.id)}
            </TooltipContent>
          </Tooltip>
        );
      })}
    </nav>
  );
}
