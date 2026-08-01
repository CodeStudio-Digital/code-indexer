import type { AssistantTurn, StreamBlock } from '../../hooks/useAgentStream.js';
import type {
  PersistedTasksState,
  SessionData,
  ToolResultView,
  VisualGroup,
} from './types.js';
import {
  buildPersistedLiveReconciliation,
  groupMessages,
  isLiveTurnDuplicatedInHistory,
  liveTurnContinuesPersistedAssistant,
  liveTurnCoversPersistedAssistantRun,
  mergeConsecutiveAssistantGroups,
  suppressLatestPersistedAssistantRun,
  suppressPersistedAgentDuplicates,
  visibleLiveBlocks,
  type LiveAgentIdentity,
  type PersistedLiveReconciliation,
} from './utils.js';

export interface TranscriptProjection {
  reconciliation: PersistedLiveReconciliation;
  historyGroups: VisualGroup[];
  toolResultsById: Map<string, ToolResultView>;
  activeTasksToolUseId: string | null;
  live: {
    blocks: StreamBlock[];
    duplicated: boolean;
    replacesPersistedTail: boolean;
    continuation: boolean;
    agentIdentities: LiveAgentIdentity[];
  };
}

export function buildTranscriptProjection(
  sessionData: SessionData | null,
  currentTurn: AssistantTurn | null,
  tasksState?: PersistedTasksState | null,
): TranscriptProjection {
  const messages = sessionData?.messages ?? [];
  const fallbackResults = sessionData?.tool_results ?? [];
  const reconciliation = buildPersistedLiveReconciliation(
    messages,
    sessionData?.preceding_user_seq,
    fallbackResults.map((result) => result.tool_use_id),
  );
  const duplicated = isLiveTurnDuplicatedInHistory(
    currentTurn,
    reconciliation,
    reconciliation.persistedToolUseIds,
  );
  const replacesPersistedTail = !duplicated
    && liveTurnCoversPersistedAssistantRun(currentTurn, reconciliation);
  const blocks = duplicated
    ? []
    : visibleLiveBlocks(
        currentTurn?.blocks ?? [],
        reconciliation.persistedToolUseIds,
        reconciliation.pendingInteractivePromptSignatures,
        reconciliation.persistedToolResultIds,
        replacesPersistedTail,
        reconciliation,
      );

  return {
    reconciliation,
    historyGroups: groupMessages(messages, sessionData?.message_rows ?? []),
    toolResultsById: buildToolResultIndex(sessionData),
    activeTasksToolUseId: findActiveTasksToolUseId(messages, tasksState),
    live: {
      blocks,
      duplicated,
      replacesPersistedTail,
      continuation: replacesPersistedTail
        ? false
        : liveTurnContinuesPersistedAssistant(messages),
      agentIdentities: collectLiveAgentIdentities(
        currentTurn?.blocks ?? [],
        reconciliation.persistedToolResultIds,
      ),
    },
  };
}

export function projectTranscriptHistory(
  groups: VisualGroup[],
  projection: TranscriptProjection,
  precedingUserMessageId?: number | null,
): VisualGroup[] {
  const chronological = projection.live.replacesPersistedTail
    ? suppressLatestPersistedAssistantRun(groups, precedingUserMessageId)
    : groups;
  return mergeConsecutiveAssistantGroups(
    suppressPersistedAgentDuplicates(
      chronological,
      projection.live.agentIdentities,
      projection.toolResultsById,
    ),
  );
}

function buildToolResultIndex(sessionData: SessionData | null): Map<string, ToolResultView> {
  const results = new Map<string, ToolResultView>();
  for (const result of sessionData?.tool_results ?? []) {
    results.set(result.tool_use_id, {
      content: result.content ?? '',
      isError: Boolean(result.is_error),
      truncated: Boolean(result._truncated),
      originalLength: result._originalLength,
    });
  }
  for (const message of sessionData?.messages ?? []) {
    if (message.role !== 'tool') continue;
    for (const block of message.content) {
      if (block.type !== 'tool_result' || !block.tool_use_id) continue;
      results.set(block.tool_use_id, {
        content: block.content ?? '',
        isError: Boolean(block.is_error),
        truncated: Boolean(block._truncated),
        originalLength: block._originalLength,
      });
    }
  }
  return results;
}

function findActiveTasksToolUseId(
  messages: SessionData['messages'],
  tasksState?: PersistedTasksState | null,
): string | null {
  if (!tasksState?.tasks?.length) return null;
  let activeId: string | null = null;
  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    for (const block of message.content) {
      if (
        block.type === 'tool_use'
        && (block.name === 'submit_tasks' || block.name === 'task_list')
        && block.id
      ) activeId = block.id;
    }
  }
  return activeId;
}

function collectLiveAgentIdentities(
  blocks: StreamBlock[],
  persistedToolResultIds: Set<string>,
): LiveAgentIdentity[] {
  return blocks.flatMap((block) => {
    if (block.type !== 'agents' || block.group.groupId.startsWith('tasks-wave-')) return [];
    if (
      block.group.status === 'completed'
      && block.group.toolUseId
      && persistedToolResultIds.has(block.group.toolUseId)
    ) return [];
    return [{ toolUseId: block.group.toolUseId, groupId: block.group.groupId }];
  });
}
