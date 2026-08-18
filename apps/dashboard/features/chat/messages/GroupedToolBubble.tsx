import React from 'react';
import type {
  ContentBlock,
  MessageRow,
  PersistedMessage,
  PersistedTasksState,
  PromptHandlers,
  ToolResultView,
  VisualGroup,
} from '../types.js';
import { CopyMarkdownButton } from './CopyMarkdownButton.js';
import { renderAssistantBlock } from './MessageView.js';

type AssistantGroup = Extract<VisualGroup, { kind: 'assistant' }>;

interface GroupedToolBubbleProps {
  group: AssistantGroup;
  toolResultsById: Map<string, ToolResultView>;
  sessionId?: string;
  handlers: PromptHandlers;
  tasksState: PersistedTasksState | null | undefined;
  /** tool_use id of the session's current task list — only that card overlays
   *  the live `tasksState`; see deriveTaskCardState. */
  activeTasksToolUseId: string | null;
}

function aggregateUsage(usages: (MessageRow | undefined)[]): {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
} {
  let input = 0;
  let output = 0;
  let cache = 0;
  for (const u of usages) {
    if (!u) continue;
    input += u.input_tokens;
    output += u.output_tokens;
    cache += u.cache_read_tokens ?? 0;
  }
  return { input_tokens: input, output_tokens: output, cache_read_tokens: cache };
}

export const GroupedToolBubble = React.memo(function GroupedToolBubble({
  group,
  toolResultsById,
  sessionId,
  handlers,
  tasksState,
  activeTasksToolUseId,
}: GroupedToolBubbleProps) {
  const agg = aggregateUsage(group.usages);
  const hasTokens = agg.input_tokens > 0 || agg.output_tokens > 0;

  const tokenBadge = hasTokens ? (
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

  // Collect text from all messages for copy button
  const allText = group.messages
    .flatMap((m) => m.content.filter((b) => b.type === 'text').map((b) => b.text ?? ''))
    .join('\n\n');

  return (
    <div className="group/msg w-full py-1">
      <article className="relative w-full min-w-0 py-1">
        <div className="absolute right-0 top-0 z-10 flex items-center gap-1 opacity-0 transition-opacity group-hover/msg:opacity-100 focus-within:opacity-100">
          {tokenBadge}
          {allText && <CopyMarkdownButton text={allText} />}
        </div>
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
