import { useTranslation } from 'react-i18next';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../../components/ui/tabs.js';
import { SessionStateSidebar } from '../SessionStateSidebar.js';
import { PlansPanel } from './PlansPanel.js';
import type { ActiveProcess, TodoItem } from '../../../hooks/agent-stream/types.js';

export function SessionStatePanel({ sessionId, refreshKey, todos, activeProcesses, showPlans, onSelectTab }: {
  sessionId: string; refreshKey: number; todos: TodoItem[]; activeProcesses: ActiveProcess[];
  showPlans: boolean; onSelectTab: (plans: boolean) => void;
}) {
  const { t } = useTranslation('chat');
  return <Tabs value={showPlans ? 'plans' : 'progress'} onValueChange={(tab) => onSelectTab(tab === 'plans')} className="flex h-full min-h-0 flex-col">
    <TabsList aria-label={t('rightRail.state')} className="mx-3 my-2 h-8 shrink-0 self-start">
      <TabsTrigger value="progress" className="text-xs">{t('rightRail.progress')}</TabsTrigger>
      <TabsTrigger value="plans" className="text-xs">{t('rightRail.plans')}</TabsTrigger>
    </TabsList>
    <TabsContent value="progress" className="mt-0 min-h-0 flex-1 overflow-auto">
      <SessionStateSidebar sessionId={sessionId} refreshKey={refreshKey} todos={todos} activeProcesses={activeProcesses} embedded />
    </TabsContent>
    <TabsContent value="plans" className="mt-0 min-h-0 flex-1 overflow-auto">
      <PlansPanel key={`${sessionId}:${refreshKey}`} sessionId={sessionId} active={showPlans} />
    </TabsContent>
  </Tabs>;
}
