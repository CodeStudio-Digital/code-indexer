/**
 * LeftTabs — slim vertical icon strip that switches which panel occupies
 * the left rail (IntelliJ-style tool-window selector). Controlled: the
 * orchestrator owns `active` (persisted as `leftTab` in
 * sprite-studio-ui-state) and passes the tab defs — usually the
 * side==='left' entries of STUDIO_PANELS from panel-registry (the item
 * shape below is a structural subset of StudioPanelDef).
 */
import { useTranslation } from 'react-i18next';
import type { LucideIcon } from 'lucide-react';
import { cn } from '../../../lib/utils.js';

export interface LeftTabItem {
  id: string;
  icon: LucideIcon;
  /** i18n key in the `spriteStudio` namespace (tooltip + aria label). */
  titleKey: string;
}

export function LeftTabs({
  active, onChange, tabs,
}: {
  active: string;
  onChange: (id: string) => void;
  tabs: LeftTabItem[];
}) {
  const { t } = useTranslation('spriteStudio');
  return (
    <div
      role="tablist"
      aria-orientation="vertical"
      className="flex h-full w-8 shrink-0 flex-col items-center gap-0.5 border-r bg-card/40 py-1"
    >
      {tabs.map((tab) => {
        const Icon = tab.icon;
        const label = t(tab.titleKey);
        const isActive = tab.id === active;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={isActive}
            title={label}
            aria-label={label}
            onClick={() => onChange(tab.id)}
            className={cn(
              'relative flex h-7 w-7 items-center justify-center rounded transition-colors',
              isActive
                ? 'bg-muted text-foreground'
                : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
            )}
          >
            {isActive && <span aria-hidden className="absolute bottom-1 left-0 top-1 w-0.5 rounded bg-primary" />}
            <Icon className="h-4 w-4" />
          </button>
        );
      })}
    </div>
  );
}
