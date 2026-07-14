/**
 * BottomPanel — the studio's bottom dock ("console"): an empty shell today;
 * generation/job logs land here in a later wave. Unlike before, it is mounted
 * INSIDE a resizable react-resizable-panels Panel (see StudioPanels) — so it
 * behaves like the ProjectView bottom drawer: a bounded, resizable strip, never
 * a full-window takeover. It renders only its own body + a slim header (tab
 * chip + close chevron); the surrounding Panel owns the height and the parent
 * owns visibility (persisted via sprite-studio-ui-state `panelsCollapsed.bottom`).
 */
import { useTranslation } from 'react-i18next';
import { ChevronDown, SquareTerminal } from 'lucide-react';

export function BottomPanel({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation('spriteStudio');
  const title = t('panels.console');
  return (
    <div className="flex h-full min-h-0 flex-col border-t border-[var(--workbench-border)] bg-[var(--workbench-surface)]">
      <div className="flex h-8 shrink-0 items-center gap-1 border-b border-[var(--workbench-border)] bg-[var(--workbench-raised)] px-1">
        <div className="flex min-w-0 flex-1 items-center gap-0.5">
          <span className="flex h-7 items-center gap-1.5 border-b-2 border-violet-400 px-2 text-xs text-foreground">
            <SquareTerminal className="h-3 w-3" />
            {title}
          </span>
        </div>
        <button
          type="button"
          onClick={onClose}
          title={t('panels.collapse', { title })}
          aria-label={t('panels.collapse', { title })}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-[var(--workbench-hover)] hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          <ChevronDown className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="flex min-h-0 flex-1 items-center justify-center p-3 text-center text-xs text-muted-foreground">
        {t('panels.bottomPlaceholder')}
      </div>
    </div>
  );
}
