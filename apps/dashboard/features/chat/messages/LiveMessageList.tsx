import { useEffect, useMemo, useRef } from 'react';
import { useAgentCurrentTurn } from '../../../hooks/useAgentStream.js';
import { isLiveTurnDuplicatedInHistory } from '../utils.js';
import { MessageList, type MessageListProps } from './MessageList.js';

const GOAL_TOOL_NAMES = new Set([
  'create_goal', 'update_goal', 'get_goal', 'task_list', 'todo_write',
  'update_todo', 'submit_tasks', 'list_tasks', 'cancel_tasks', 'delete_tasks',
  'archive_task_list', 'execute_tasks', 'execute_task', 'task_complete',
  'update_task', 'approve_subordinate_tasks', 'submit_tasks_to_master',
]);

interface LiveMessageListProps extends Omit<
  MessageListProps,
  'currentTurn' | 'liveTurnDuplicatedInHistory'
> {
  sessionId: number;
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
  const duplicated = useMemo(
    () => isLiveTurnDuplicatedInHistory(
      currentTurn,
      sessionData?.messages ?? [],
      persistedToolUseIds,
    ),
    [currentTurn, persistedToolUseIds, sessionData],
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
      liveTurnDuplicatedInHistory={duplicated}
      persistedToolUseIds={persistedToolUseIds}
    />
  );
}
