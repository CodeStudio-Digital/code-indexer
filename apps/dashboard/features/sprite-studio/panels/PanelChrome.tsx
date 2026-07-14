/**
 * PanelChrome — reusable IDE-style chrome around a studio panel: a slim
 * header strip (icon + uppercase title + collapse chevron) above the body.
 * When `collapsed` it can render only a CollapsedRail for standalone use.
 * StudioPanels keeps the full body mounted inside a collapsible Panel so
 * tool-window state and long-running work are preserved.
 *
 * Pure/controlled: no internal state — the orchestrator owns `collapsed`
 * (persisted via sprite-studio-ui-state `panelsCollapsed`) and decides
 * where to mount this. Expanded panels inherit their border and radius from
 * WorkbenchSurface; the standalone collapsed form keeps its own side border.
 * Visual language follows the shared workbench tokens.
 */
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronsDown, ChevronsLeft, ChevronsRight } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '../../../lib/utils.js';

export type PanelSide = 'left' | 'right' | 'bottom';

export interface PanelChromeProps {
  /** Already-translated header title. */
  title: string;
  icon: LucideIcon;
  side: PanelSide;
  collapsed: boolean;
  onToggle: () => void;
  children: ReactNode;
  /** Optional right-aligned header extras (e.g. a refresh button). */
  actions?: ReactNode;
  className?: string;
}

const COLLAPSE_CHEVRON: Record<PanelSide, LucideIcon> = {
  left: ChevronsLeft,
  right: ChevronsRight,
  bottom: ChevronsDown,
};

const SIDE_BORDER: Record<PanelSide, string> = {
  left: 'border-r',
  right: 'border-l',
  bottom: 'border-t',
};

export function PanelChrome({
  title, icon, side, collapsed, onToggle, children, actions, className,
}: PanelChromeProps) {
  const { t } = useTranslation('spriteStudio');
  if (collapsed) {
    return <CollapsedRail title={title} icon={icon} side={side} onToggle={onToggle} className={className} />;
  }
  const Icon = icon;
  const Chevron = COLLAPSE_CHEVRON[side];
  return (
    <div className={cn('flex h-full min-h-0 flex-col overflow-hidden bg-[var(--workbench-surface)]', className)}>
      <div className="flex h-8 shrink-0 items-center gap-1.5 border-b border-[var(--workbench-border)] bg-[var(--workbench-raised)] px-2">
        <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-[11px] font-semibold text-foreground">
          {title}
        </span>
        {actions}
        <button
          type="button"
          onClick={onToggle}
          title={t('panels.collapse', { title })}
          aria-label={t('panels.collapse', { title })}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-[var(--workbench-hover)] hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          <Chevron className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
    </div>
  );
}

/**
 * CollapsedRail — the minimized form of a panel: a slim bar carrying one
 * icon button that re-expands. Vertical (w-7, full height) for left/right,
 * horizontal (h-7, full width) for bottom. Also exported standalone so the
 * orchestrator can render rails without mounting PanelChrome.
 */
export function CollapsedRail({
  title, icon, side, onToggle, className,
}: {
  title: string;
  icon: LucideIcon;
  side: PanelSide;
  onToggle: () => void;
  className?: string;
}) {
  const { t } = useTranslation('spriteStudio');
  const Icon = icon;
  const vertical = side !== 'bottom';
  return (
    <div
      className={cn(
        'flex shrink-0 items-center bg-[var(--workbench-raised)]',
        vertical ? 'h-full w-7 flex-col py-1' : 'h-7 w-full flex-row px-1',
        SIDE_BORDER[side],
        className,
      )}
    >
      <button
        type="button"
        onClick={onToggle}
        title={t('panels.expand', { title })}
        aria-label={t('panels.expand', { title })}
        className="flex h-5 w-5 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-[var(--workbench-hover)] hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        <Icon className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
