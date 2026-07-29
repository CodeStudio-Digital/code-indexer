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
import { MemoryPanel } from '../../MemoryPanel.js';
import { PipelinesTab } from '../../PipelinesTab.js';
import type { useCompanyStream } from '../../../../hooks/useCompanyStream.js';
import type { BoardMessage } from '../../../../state/company/types.js';
import type { WorkTab } from '../types.js';

interface WorkZoneProps {
  sessionId: string;
  sessionName: string;
  tab: WorkTab;
  stream: ReturnType<typeof useCompanyStream>;
  boardMessages: BoardMessage[];
  /**
   * Master composer rendered BELOW the Board surface only. Kanban /
   * Pipelines don't get it — they're observation surfaces, not
   * conversation entry points. CompanySessionView builds
   * the composer once and passes it down so its closures (provider,
   * thinking flag, placeholder) stay co-located with the rest of
   * the session state.
   */
  composer?: React.ReactNode;
  /** App-owned teams are inspected here; interaction belongs to App Studio. */
  readOnly?: boolean;
}

export function WorkZone({
  sessionId,
  sessionName,
  tab,
  stream,
  boardMessages,
  composer,
  readOnly = false,
}: WorkZoneProps) {
  if (tab === 'board') {
    return (
      <div className="flex-1 overflow-hidden flex flex-col">
        <div className="flex-1 min-h-0 overflow-hidden flex flex-col">
          <BoardPanel
            messages={boardMessages}
            masterPrompts={Array.from(stream.masterPrompts.values())}
            onAnswerQuestion={readOnly
              ? undefined
              : (promptId, answer) => stream.respondToMasterQuestion(promptId, answer)}
            onRespondPlan={readOnly
              ? undefined
              : (promptId, approved, fb) => stream.respondToMasterPlan(promptId, approved, fb)}
            sessionId={sessionId}
            sessionName={sessionName}
          />
        </div>
        {composer && <div className="border-t p-3 shrink-0">{composer}</div>}
      </div>
    );
  }
  if (tab === 'kanban') {
    return <KanbanTab companySessionId={sessionId} />;
  }
  if (tab === 'memory') {
    return <MemoryPanel sessionId={sessionId} />;
  }
  return <PipelinesTab companySessionId={sessionId} />;
}
