import { useEffect, useState } from 'react';
import { FileText, Gauge, LayoutDashboard, Wrench } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../../components/ui/tabs.js';
import {
  SessionInputsView,
  SessionSummaryView,
  type SessionLike,
  type SessionStatsLike,
} from '../SessionDetailsModal.js';
import { SessionMetricsView } from '../SessionMetricsModal.js';
import { ToolStatsView } from '../ToolStatsModal.js';
import {
  SESSION_INSIGHTS_TAB_EVENT,
  SESSION_INSIGHTS_TABS as VALID_TABS,
  readInitialSessionInsightsTab as readInitialTab,
  SESSION_INSIGHTS_TAB_STORAGE_KEY,
  type SessionInsightsTab,
} from './session-insights-tabs.js';

interface SessionInsightsPanelProps {
  sessionId: string;
  session: SessionLike | null;
  stats: SessionStatsLike | null;
}

/**
 * One calm inspection surface for session health, cost, tools and raw inputs.
 * Only the active tab mounts its data-heavy view, keeping the rail responsive
 * and avoiding the three parallel fetches the former independent panels made.
 */
export function SessionInsightsPanel({ sessionId, session, stats }: SessionInsightsPanelProps) {
  const { t } = useTranslation('chat');
  const [activeTab, setActiveTab] = useState<SessionInsightsTab>(readInitialTab);

  useEffect(() => {
    const onRequestedTab = (event: Event) => {
      const next = (event as CustomEvent<SessionInsightsTab>).detail;
      if (VALID_TABS.has(next)) setActiveTab(next);
    };
    window.addEventListener(SESSION_INSIGHTS_TAB_EVENT, onRequestedTab);
    return () => window.removeEventListener(SESSION_INSIGHTS_TAB_EVENT, onRequestedTab);
  }, []);

  const selectTab = (value: string) => {
    const next = value as SessionInsightsTab;
    if (!VALID_TABS.has(next)) return;
    setActiveTab(next);
    window.localStorage.setItem(SESSION_INSIGHTS_TAB_STORAGE_KEY, next);
  };

  const tabs = [
    { id: 'overview' as const, icon: LayoutDashboard, label: t('insights.overview') },
    { id: 'usage' as const, icon: Gauge, label: t('insights.usage') },
    { id: 'tools' as const, icon: Wrench, label: t('insights.tools') },
    { id: 'inputs' as const, icon: FileText, label: t('insights.inputs') },
  ];

  return (
    <Tabs
      value={activeTab}
      onValueChange={selectTab}
      className="flex h-full min-h-0 flex-col"
    >
      <div className="shrink-0 border-b bg-[var(--workbench-surface)] px-2 py-1.5">
        <TabsList
          className="flex h-9 w-full justify-start gap-0.5 overflow-x-auto rounded-md bg-muted/40 p-0.5"
          aria-label={t('insights.tabsLabel')}
        >
          {tabs.map(({ id, icon: Icon, label }) => (
            <TabsTrigger
              key={id}
              value={id}
              title={label}
              className="h-8 min-w-[64px] flex-1 gap-1 rounded px-1.5 text-[10px] shadow-none data-[state=active]:bg-background data-[state=active]:shadow-sm"
            >
              <Icon className="h-3.5 w-3.5 shrink-0" />
              <span className="truncate">{label}</span>
            </TabsTrigger>
          ))}
        </TabsList>
      </div>

      <TabsContent value="overview" className="mt-0 flex flex-1 min-h-0 flex-col overflow-y-auto px-3 py-3">
        {session ? (
          <SessionSummaryView session={session} stats={stats} />
        ) : (
          <div className="text-xs text-muted-foreground">{t('details.noData')}</div>
        )}
      </TabsContent>

      <TabsContent value="usage" className="mt-0 flex flex-1 min-h-0 flex-col overflow-hidden">
        <SessionMetricsView sessionId={sessionId} active={activeTab === 'usage'} />
      </TabsContent>

      <TabsContent value="tools" className="mt-0 flex flex-1 min-h-0 flex-col overflow-hidden">
        <ToolStatsView sessionId={sessionId} active={activeTab === 'tools'} />
      </TabsContent>

      <TabsContent value="inputs" className="mt-0 flex flex-1 min-h-0 flex-col overflow-hidden">
        <SessionInputsView sessionId={sessionId} active={activeTab === 'inputs'} />
      </TabsContent>
    </Tabs>
  );
}
