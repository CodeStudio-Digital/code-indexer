import { useEffect, useMemo, useRef } from 'react';
import { useAgentCurrentTurn } from '../../../hooks/useAgentStream.js';
import {
  liveTurnReconciliationRevision,
} from '../utils.js';
import { buildTranscriptProjection } from '../transcript-projection.js';
import { MessageList, type MessageListProps } from './MessageList.js';

const TASK_TOOL_NAMES = new Set([
  'task_list', 'todo_write',
  'update_todo', 'submit_tasks', 'list_tasks', 'cancel_tasks', 'delete_tasks',
  'archive_task_list', 'execute_tasks', 'execute_task', 'task_complete',
  'update_task', 'approve_subordinate_tasks', 'submit_tasks_to_master',
]);

interface LiveMessageListProps extends Omit<
  MessageListProps,
  'currentTurn' | 'projection'
> {
  sessionId: string;
  onClearCurrentTurn: () => void;
  onTaskToolCompleted: () => void;
}

/**
 * Live-turn subscription boundary. Token/tool frames stop here instead of
 * reconciling the entire AgentChat shell, sidebars, dialogs and composer.
 */
export function LiveMessageList({
  sessionId,
  sessionData,
  tasksState,
  onClearCurrentTurn,
  onTaskToolCompleted,
  ...props
}: LiveMessageListProps) {
  const currentTurn = useAgentCurrentTurn(sessionId);
  const historyProjection = useMemo(
    () => buildTranscriptProjection(sessionData, null, tasksState),
    [sessionData, tasksState],
  );
  const currentTurnRef = useRef(currentTurn);
  currentTurnRef.current = currentTurn;
  const reconciliationRevision = liveTurnReconciliationRevision(
    currentTurn,
    historyProjection.reconciliation.tailTextLength,
    historyProjection.reconciliation.tailThinkingLength,
  );
  const projection = useMemo(
    () => buildTranscriptProjection(sessionData, currentTurnRef.current, tasksState),
    [sessionData, tasksState, reconciliationRevision],
  );

  useEffect(() => {
    if (projection.live.duplicated) onClearCurrentTurn();
  }, [onClearCurrentTurn, projection.live.duplicated]);

  const completedTaskToolsRef = useRef(0);
  useEffect(() => {
    if (!currentTurn) {
      completedTaskToolsRef.current = 0;
      return;
    }
    let count = 0;
    for (const block of currentTurn.blocks) {
      if (block.type === 'tool' && block.call.status === 'done' && TASK_TOOL_NAMES.has(block.call.name)) {
        count++;
      }
    }
    if (count > completedTaskToolsRef.current) onTaskToolCompleted();
    completedTaskToolsRef.current = count;
  }, [currentTurn, onTaskToolCompleted]);

  return (
    <MessageList
      {...props}
      sessionData={sessionData}
      currentTurn={currentTurn}
      projection={projection}
      tasksState={tasksState}
    />
  );
}
