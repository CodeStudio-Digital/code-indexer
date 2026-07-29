import { lazy, Suspense, useEffect, useState } from 'react';
import { ChevronDown, Loader2, Play, TerminalSquare, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../components/ui/button.js';
import { cn } from '../../lib/utils.js';
import { CompanyTerminalPanel } from './terminal/CompanyTerminalPanel.js';
import type { SessionProject } from './session-view/types.js';

const CompanyRunnersTab = lazy(() =>
  import('./zones/build/RunnersTab.js').then((module) => ({ default: module.RunnersTab })),
);

export type CompanyBottomTab = 'terminal' | 'runners';

interface CompanyBottomPanelProps {
  companySessionId: string;
  projects: SessionProject[];
  hasSandbox: boolean;
  activeTab: CompanyBottomTab;
  onSelectTab: (tab: CompanyBottomTab) => void;
  onCollapse: () => void;
  onClose: () => void;
}

const TABS = [
  { id: 'terminal' as const, labelKey: 'company.terminal', Icon: TerminalSquare },
  { id: 'runners' as const, labelKey: 'company.runners', Icon: Play },
];

/**
 * Company-session bottom dock. It follows the same tabbed workbench chrome as
 * the project bottom panel while keeping the company-aware terminal targets
 * and the linked-project selector used by Runners.
 */
export function CompanyBottomPanel({
  companySessionId,
  projects,
  hasSandbox,
  activeTab,
  onSelectTab,
  onCollapse,
  onClose,
}: CompanyBottomPanelProps) {
  const { t } = useTranslation('agents');
  // Once opened, keep Runners mounted while switching bottom tabs. This avoids
  // re-detecting scripts and preserves its selected project during the panel
  // session. The terminal is also kept mounted so its xterm surface does not
  // detach when the user briefly inspects a runner.
  const [runnersMounted, setRunnersMounted] = useState(activeTab === 'runners');

  useEffect(() => {
    if (activeTab === 'runners') setRunnersMounted(true);
  }, [activeTab]);

  const renderRunners = runnersMounted || activeTab === 'runners';

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--workbench-surface)]">
      <div className="flex h-8 shrink-0 items-center gap-0.5 border-b border-[var(--workbench-border)] bg-[var(--workbench-raised)] px-1">
        <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto">
          {TABS.map(({ id, labelKey, Icon }) => (
            <button
              key={id}
              type="button"
              onClick={() => onSelectTab(id)}
              aria-pressed={activeTab === id}
              className={cn(
                'flex items-center gap-1.5 rounded px-2 py-1 text-xs transition-colors',
                activeTab === id
                  ? 'bg-[var(--workbench-active)] text-foreground'
                  : 'text-muted-foreground hover:bg-[var(--workbench-hover)] hover:text-foreground',
              )}
            >
              <Icon className="h-3 w-3" />
              <span>{t(labelKey)}</span>
            </button>
          ))}
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={onCollapse}
            aria-label={t('company.bottomPanel.collapse')}
          >
            <ChevronDown className="h-3 w-3" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={onClose}
            aria-label={t('company.bottomPanel.close')}
          >
            <X className="h-3 w-3" />
          </Button>
        </div>
      </div>

      <div className="relative min-h-0 flex-1 overflow-hidden">
        <div className={cn('absolute inset-0', activeTab !== 'terminal' && 'invisible')}>
          <CompanyTerminalPanel
            companySessionId={companySessionId}
            projects={projects}
            hasSandbox={hasSandbox}
          />
        </div>
        {renderRunners && (
          <div className={cn('absolute inset-0', activeTab !== 'runners' && 'invisible')}>
            <Suspense
              fallback={
                <div className="grid h-full place-items-center">
                  <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                </div>
              }
            >
              <CompanyRunnersTab projects={projects} />
            </Suspense>
          </div>
        )}
      </div>
    </div>
  );
}
