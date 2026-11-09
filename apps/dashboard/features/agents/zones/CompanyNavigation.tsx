import { BookOpen, ClipboardList, GitCompare, MessageSquare, MonitorCheck } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '../../../lib/utils.js';
import { COMPANY_AREAS, COMPANY_DETAIL_TABS, companyAreaForTab } from './company-navigation.js';
import type { Zone } from './types.js';

const icons = { conversation: MessageSquare, tasks: ClipboardList, changes: GitCompare, qa: MonitorCheck, knowledge: BookOpen };

/** One navigation model; old deep links keep resolving to their current area. */
export function CompanyNavigation({ tab, onChange }: { tab: string; onChange: (zone: Zone, tab: string) => void }) {
  const { t } = useTranslation('agents');
  const active = companyAreaForTab(tab);
  return <>
    <nav aria-label={t('company.mainNavigation', 'Session workspace')} className="flex shrink-0 items-center gap-1 overflow-x-auto border-b bg-[var(--workbench-surface)] px-3 py-2">
      {COMPANY_AREAS.map((area) => {
        const Icon = icons[area.id];
        return <button key={area.id} type="button" aria-current={active.id === area.id ? 'page' : undefined}
          onClick={() => onChange(area.zone, area.tab)}
          className={cn('flex shrink-0 items-center gap-2 rounded-md px-3 py-2 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
            active.id === area.id ? 'bg-primary/15 text-primary' : 'text-muted-foreground hover:bg-muted hover:text-foreground')}>
          <Icon className="size-3.5" />{t(area.label, area.fallback)}
        </button>;
      })}
    </nav>
    {active.tabs.length > 1 && <nav aria-label={t('company.detailsNavigation', 'Workspace sections')} className="flex shrink-0 items-center gap-4 overflow-x-auto border-b px-4">
      {active.tabs.map((detail) => {
        const item = COMPANY_DETAIL_TABS[detail]!;
        return <button key={detail} type="button" aria-current={tab === detail ? 'page' : undefined}
          onClick={() => onChange(item.zone, detail)}
          className={cn('whitespace-nowrap border-b-2 py-2.5 text-xs transition-colors', tab === detail ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground')}>
          {t(item.label, item.fallback)}
        </button>;
      })}
    </nav>}
  </>;
}
