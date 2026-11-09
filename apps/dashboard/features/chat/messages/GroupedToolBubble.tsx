import React from 'react';
import type {
  ContentBlock,
  PersistedTasksState,
  PromptHandlers,
  ToolResultView,
  VisualGroup,
} from '../types.js';
import { CopyMarkdownButton } from './CopyMarkdownButton.js';
import { renderAssistantBlock } from './MessageView.js';
import { assistantTurnHeader, type AssistantTurnHeader } from './transcript-segments.js';

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
  header?: AssistantTurnHeader | false;
}

export const GroupedToolBubble = React.memo(function GroupedToolBubble({
  group,
  toolResultsById,
  sessionId,
  handlers,
  tasksState,
  activeTasksToolUseId,
  header,
}: GroupedToolBubbleProps) {
  const agg = header === undefined ? assistantTurnHeader(group) : header;
  const hasTokens = agg && (agg.input_tokens > 0 || agg.output_tokens > 0);

  const tokenBadge = agg && hasTokens ? (
    <span className="text-[10px] text-muted-foreground tabular-nums ml-1.5 inline-flex items-center gap-1">
      <span>
        ↑{agg.input_tokens.toLocaleString()} ↓{agg.output_tokens.toLocaleString()}
      </span>
      {agg.cache_read_tokens > 0 && (
        <span className="text-emerald-600 dark:text-emerald-400">
          ⚡{agg.cache_read_tokens.toLocaleString()}
        </span>
      )}
    </span>
  ) : null;

  const allText = agg ? agg.markdown : '';

  return (
    <div className="group/msg w-full">
      <article className="relative w-full min-w-0">
        {agg && <div className="absolute right-0 top-0 z-10 flex items-center gap-1 opacity-0 transition-opacity group-hover/msg:opacity-100 focus-within:opacity-100">
          {tokenBadge}
          {allText && <CopyMarkdownButton text={allText} />}
        </div>}
        <div className="min-w-0">
          {group.messages.map((msg, mi) =>
            msg.content.map((b: ContentBlock, bi: number) =>
              renderAssistantBlock(
                b,
                mi * 1000 + bi,
                {
                  onAnswer: handlers.onAnswer,
                  onPlanResponse: handlers.onPlanResponse,
                  onTasksResponse: handlers.onTasksResponse,
                  onDecide: handlers.onDecide,
                  // Without this a pending spec card fell back to a no-op and
                  // its approve/reject buttons did nothing.
                  onSpecResponse: handlers.onSpecResponse,
                },
                toolResultsById,
                tasksState,
                activeTasksToolUseId,
                sessionId,
              ),
            ),
          )}
        </div>
      </article>
    </div>
  );
});
