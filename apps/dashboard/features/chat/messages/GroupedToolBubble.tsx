import React from 'react';
import type {
  ContentBlock,
  PersistedTasksState,
  PromptHandlers,
  ToolResultView,
  VisualGroup,
} from '../types.js';
import { renderAssistantBlock } from './MessageView.js';

type AssistantGroup = Extract<VisualGroup, { kind: 'assistant' }>;

interface GroupedToolBubbleProps {
  group: AssistantGroup;
  toolResultsById: ReadonlyMap<string, ToolResultView>;
  sessionId?: string;
  handlers: PromptHandlers;
  tasksState: PersistedTasksState | null | undefined;
  /** tool_use id of the session's current task list — only that card overlays
   *  the live `tasksState`; see deriveTaskCardState. */
  activeTasksToolUseId: string | null;
}

export const GroupedToolBubble = React.memo(function GroupedToolBubble({
  group,
  toolResultsById,
  sessionId,
  handlers,
  tasksState,
  activeTasksToolUseId,
}: GroupedToolBubbleProps) {
  return (
    <article className="w-full min-w-0 text-foreground">
      {group.messages.map((message, index) =>
        message.content.map((block: ContentBlock, offset: number) =>
          renderAssistantBlock(block, index * 1000 + offset, handlers, toolResultsById,
            tasksState, activeTasksToolUseId, sessionId),
        ),
      )}
    </article>
  );
});
