/**
 * Work zone: day-to-day collaboration surfaces.
 *
 * Board is the agent ↔ master conversation; Kanban tracks tasks;
 * Pipelines lets the master orchestrate multi-step workflows. Inbox
 * moved to the right-side drawer (`preview-sidebar/SidebarRail`) so
 * users can keep it open alongside whichever tab is active.
 */
import { BoardPanel } from '../../BoardPanel.js';
import { KanbanTab } from '../../KanbanTab.js';
import { PipelinesTab } from '../../PipelinesTab.js';
import type { useCompanyStream } from '../../../../hooks/useCompanyStream.js';
import type { BoardMessage } from '../../../../state/company/types.js';
import type { WorkTab } from '../types.js';

interface WorkZoneProps {
  sessionId: number;
  sessionName: string;
  tab: WorkTab;
  stream: ReturnType<typeof useCompanyStream>;
  boardMessages: BoardMessage[];
}

export function WorkZone({
  sessionId,
  sessionName,
  tab,
  stream,
  boardMessages,
}: WorkZoneProps) {
  if (tab === 'board') {
    return (
      <div className="flex-1 overflow-hidden flex flex-col">
        <BoardPanel
          messages={boardMessages}
          masterPrompts={Array.from(stream.masterPrompts.values())}
          onAnswerQuestion={(promptId, answer) => stream.respondToMasterQuestion(promptId, answer)}
          onRespondPlan={(promptId, approved, fb) => stream.respondToMasterPlan(promptId, approved, fb)}
          sessionId={sessionId}
          sessionName={sessionName}
        />
      </div>
    );
  }
  if (tab === 'kanban') {
    return <KanbanTab companySessionId={sessionId} />;
  }
  return <PipelinesTab companySessionId={sessionId} />;
}
