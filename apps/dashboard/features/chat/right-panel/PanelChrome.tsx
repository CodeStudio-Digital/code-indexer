/**
 * Standardised chrome for every right-panel — a thin header with an
 * icon, title, optional extra actions, and a close (X) button. The body
 * is a flex column that scrolls independently of the header.
 *
 * Lives inside `RightPanelHost`, which decides which body to render
 * based on the active panel id. Each panel component (e.g.
 * `SkillConfigPanel`) renders `<PanelChrome>` once and passes its body
 * as children.
 */
import type { LucideIcon } from 'lucide-react';
import { cn } from '../../../lib/utils.js';
import { WorkbenchPanelHeader } from '../../../components/workbench/index.js';

export interface PanelChromeProps {
  title: string;
  icon: LucideIcon;
  /** Right-aligned action slots (header buttons). Optional. */
  actions?: React.ReactNode;
  /** Close handler — wired to the rail's "deactivate" action. */
  onClose: () => void;
  /** Extra classes applied to the scrollable body container. */
  bodyClassName?: string;
  children: React.ReactNode;
}

export function PanelChrome({
  title,
  icon: Icon,
  actions,
  onClose,
  bodyClassName,
  children,
}: PanelChromeProps) {
  return (
    <div className="flex flex-col h-full min-h-0 bg-[var(--workbench-surface)]">
      <WorkbenchPanelHeader title={title} icon={Icon} actions={actions} onClose={onClose} closeLabel="Close panel" />
      <div className={cn('flex-1 min-h-0 overflow-auto', bodyClassName)}>{children}</div>
    </div>
  );
}
