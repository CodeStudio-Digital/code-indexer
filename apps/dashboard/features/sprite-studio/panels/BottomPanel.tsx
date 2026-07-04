/**
 * BottomPanel — prepared bottom dock ("studio console"): an empty shell
 * today; generation/job logs land here in a later wave. Wrapped in
 * PanelChrome (side "bottom") so it collapses to a slim horizontal rail.
 * The orchestrator mounts it collapsed-by-default and owns the toggle
 * (persisted via sprite-studio-ui-state `panelsCollapsed.bottom`).
 */
import { useTranslation } from 'react-i18next';
import { SquareTerminal } from 'lucide-react';
import { PanelChrome } from './PanelChrome.js';

export function BottomPanel({
  collapsed, onToggle, className,
}: {
  collapsed: boolean;
  onToggle: () => void;
  className?: string;
}) {
  const { t } = useTranslation('spriteStudio');
  return (
    <PanelChrome
      title={t('panels.console')}
      icon={SquareTerminal}
      side="bottom"
      collapsed={collapsed}
      onToggle={onToggle}
      className={className}
    >
      <div className="flex h-full items-center justify-center p-3 text-center text-xs text-muted-foreground">
        {t('panels.bottomPlaceholder')}
      </div>
    </PanelChrome>
  );
}
