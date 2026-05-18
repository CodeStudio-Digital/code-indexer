/**
 * Work zone: where the team operates day-to-day.
 *
 * Board is the heart of the agent ↔ master conversation; Kanban tracks
 * tasks; Inbox carries inter-agent messages; Pipelines lets the master
 * orchestrate multi-step workflows.
 *
 * `useCompanyStream` is mounted once in `CompanySessionView` and passed
 * down via the `stream` prop so the Board can show live messages without
 * remounting on tab switch.
 */
import { useTranslation } from 'react-i18next';
import { Inbox, KanbanSquare, MessageSquare, Network } from 'lucide-react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../../../components/ui/tabs.js';
import { BoardPanel } from '../../BoardPanel.js';
import { KanbanTab } from '../../KanbanTab.js';
import { PipelinesTab } from '../../PipelinesTab.js';
import { InboxPanel } from '../../InboxPanel.js';
import type { useCompanyStream } from '../../../../hooks/useCompanyStream.js';
import type { BoardMessage } from '../../../../state/company/types.js';
import type { WorkTab } from '../types.js';

interface WorkZoneProps {
  sessionId: number;
  sessionName: string;
  tab: WorkTab;
  onTabChange: (tab: WorkTab) => void;
  stream: ReturnType<typeof useCompanyStream>;
  /**
   * Board messages already merged from SSE + the initial REST fetch.
   * Passed in because `CompanySessionView` builds this from both sources;
   * keeping it here avoids re-deriving on every render.
   */
  boardMessages: BoardMessage[];
}

export function WorkZone({
  sessionId,
  sessionName,
  tab,
  onTabChange,
  stream,
  boardMessages,
}: WorkZoneProps) {
  const { t } = useTranslation('agents');

  return (
    <Tabs
      value={tab}
      onValueChange={(v) => onTabChange(v as WorkTab)}
      className="flex-1 flex flex-col overflow-hidden"
    >
      <TabsList className="mx-3 mt-2 w-fit">
        <TabsTrigger value="board" className="text-xs gap-1">
          <MessageSquare className="h-3 w-3" /> {t('company.board')}
        </TabsTrigger>
        <TabsTrigger value="kanban" className="text-xs gap-1">
          <KanbanSquare className="h-3 w-3" /> {t('company.kanban')}
        </TabsTrigger>
        <TabsTrigger value="pipelines" className="text-xs gap-1">
          <Network className="h-3 w-3" /> {t('company.pipelines')}
        </TabsTrigger>
        <TabsTrigger value="inbox" className="text-xs gap-1">
          <Inbox className="h-3 w-3" /> {t('company.inbox')}
        </TabsTrigger>
      </TabsList>

      <TabsContent value="board" className="flex-1 overflow-hidden mt-0 flex flex-col">
        <div className="flex-1 overflow-hidden">
          <BoardPanel
            messages={boardMessages}
            masterPrompts={Array.from(stream.masterPrompts.values())}
            onAnswerQuestion={(promptId, answer) => stream.respondToMasterQuestion(promptId, answer)}
            onRespondPlan={(promptId, approved, fb) => stream.respondToMasterPlan(promptId, approved, fb)}
            sessionId={sessionId}
            sessionName={sessionName}
          />
        </div>
      </TabsContent>

      <TabsContent value="kanban" className="flex-1 overflow-hidden mt-0">
        <KanbanTab companySessionId={sessionId} />
      </TabsContent>

      <TabsContent value="pipelines" className="flex-1 overflow-hidden mt-0">
        <PipelinesTab companySessionId={sessionId} />
      </TabsContent>

      <TabsContent value="inbox" className="flex-1 overflow-hidden mt-0">
        <InboxPanel companySessionId={sessionId} />
      </TabsContent>
    </Tabs>
  );
}
