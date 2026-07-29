import { useEffect, useMemo, useRef } from 'react';
import { useAgentCurrentTurn } from '../../../hooks/useAgentStream.js';
import {
  buildPersistedLiveReconciliation,
  isLiveTurnDuplicatedInHistory,
  liveTurnReconciliationRevision,
} from '../utils.js';
import { MessageList, type MessageListProps } from './MessageList.js';

const GOAL_TOOL_NAMES = new Set([
  'create_goal', 'update_goal', 'get_goal', 'task_list', 'todo_write',
  'update_todo', 'submit_tasks', 'list_tasks', 'cancel_tasks', 'delete_tasks',
  'archive_task_list', 'execute_tasks', 'execute_task', 'task_complete',
  'update_task', 'approve_subordinate_tasks', 'submit_tasks_to_master',
]);

interface LiveMessageListProps extends Omit<
  MessageListProps,
  'currentTurn' | 'liveReconciliation' | 'liveTurnDuplicatedInHistory'
> {
  sessionId: string;
  onClearCurrentTurn: () => void;
  onGoalToolCompleted: () => void;
}

/**
 * Live-turn subscription boundary. Token/tool frames stop here instead of
 * reconciling the entire AgentChat shell, sidebars, dialogs and composer.
 */
export function LiveMessageList({
  sessionId,
  sessionData,
  persistedToolUseIds,
  onClearCurrentTurn,
  onGoalToolCompleted,
  ...props
}: LiveMessageListProps) {
  const currentTurn = useAgentCurrentTurn(sessionId);
  const reconciliation = useMemo(
    () => buildPersistedLiveReconciliation(
      sessionData?.messages ?? [],
      sessionData?.preceding_user_seq,
      (sessionData?.tool_results ?? []).map((result) => result.tool_use_id),
    ),
    [sessionData],
  );
  const currentTurnRef = useRef(currentTurn);
  currentTurnRef.current = currentTurn;
  const reconciliationRevision = liveTurnReconciliationRevision(
    currentTurn,
    reconciliation.tailTextLength,
    reconciliation.tailThinkingLength,
  );
  const duplicated = useMemo(
    () => isLiveTurnDuplicatedInHistory(
      currentTurnRef.current,
      reconciliation,
      persistedToolUseIds,
    ),
    [persistedToolUseIds, reconciliation, reconciliationRevision],
  );

  useEffect(() => {
    if (duplicated) onClearCurrentTurn();
  }, [duplicated, onClearCurrentTurn]);

  const completedGoalToolsRef = useRef(0);
  useEffect(() => {
    if (!currentTurn) {
      completedGoalToolsRef.current = 0;
      return;
    }
    let count = 0;
    for (const block of currentTurn.blocks) {
      if (block.type === 'tool' && block.call.status === 'done' && GOAL_TOOL_NAMES.has(block.call.name)) {
        count++;
      }
    }
    if (count > completedGoalToolsRef.current) onGoalToolCompleted();
    completedGoalToolsRef.current = count;
  }, [currentTurn, onGoalToolCompleted]);

  return (
    <MessageList
      {...props}
      sessionData={sessionData}
      currentTurn={currentTurn}
      liveReconciliation={reconciliation}
      liveTurnDuplicatedInHistory={duplicated}
      persistedToolUseIds={persistedToolUseIds}
    />
  );
}
