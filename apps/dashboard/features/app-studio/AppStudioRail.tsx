import { Database, Globe, ListChecks, Monitor, type LucideIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { RailButton, RailContainer } from '../../components/chrome/index.js';
import type { AppStudioSessionDetail } from './app-studio-api.js';
import { PlanPanel } from './plan/PlanPanel.js';
import { DataPanel } from './data/DataPanel.js';
import { PublishPanel } from './publish/PublishPanel.js';

export type AppStudioTab = 'plan' | 'app' | 'data' | 'publish';
export const APP_STUDIO_RAIL_TABS: Array<{ id: AppStudioTab; icon: LucideIcon; labelKey: string }> = [
  { id: 'plan', icon: ListChecks, labelKey: 'v6.tabs.plan' },
  { id: 'app', icon: Monitor, labelKey: 'v6.tabs.app' },
  { id: 'data', icon: Database, labelKey: 'v6.tabs.data' },
  { id: 'publish', icon: Globe, labelKey: 'v6.tabs.publish' },
];

export function AppStudioRail({ active, onSelect }: { active: AppStudioTab; detail: AppStudioSessionDetail | null; onSelect: (tab: AppStudioTab) => void }) {
  const { t } = useTranslation('appStudio');
  return <RailContainer side="left" aria-label={t('rail.label')}>{APP_STUDIO_RAIL_TABS.map(({ id, icon, labelKey }) => <RailButton key={id} icon={icon} label={t(labelKey)} role="toggle" active={active === id} onClick={() => onSelect(id)} />)}</RailContainer>;
}

export function AppStudioTabContent({ tab, detail, onChanged }: { tab: Exclude<AppStudioTab, 'app'>; detail: AppStudioSessionDetail; onChanged: () => void }) {
  return <div className="h-full min-h-0 overflow-auto bg-[var(--workbench-surface)]">
    {tab === 'plan' && <PlanPanel detail={detail} onChanged={onChanged} />}
    {tab === 'data' && <DataPanel detail={detail} onChanged={onChanged} />}
    {tab === 'publish' && <PublishPanel detail={detail} onChanged={onChanged} />}
  </div>;
}
