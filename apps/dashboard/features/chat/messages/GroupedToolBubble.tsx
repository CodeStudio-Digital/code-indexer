import React from 'react';
import { useTranslation } from 'react-i18next';
import { Bot } from 'lucide-react';
import { Avatar, AvatarFallback } from '../../../components/ui/avatar.js';
import { cn } from '../../../lib/utils.js';
import { providerAccent } from '../constants.js';
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
  sessionId?: number;
  providerId: string;
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
  providerId,
  handlers,
  tasksState,
  activeTasksToolUseId,
}: GroupedToolBubbleProps) {
  const { t } = useTranslation('chat');
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

  // Count total tool calls for the header
  const toolCount = group.messages.reduce(
    (acc, m) => acc + m.content.filter((b) => b.type === 'tool_use').length,
    0,
  );

  return (
    <div className="group/msg w-full">
      <article className="w-full min-w-0 px-3 py-2 transition-colors hover:bg-muted/[0.018]">
        <div className="mb-1 flex items-center justify-between gap-2 text-[10px] uppercase tracking-[0.12em] text-muted-foreground/70">
          <div className="flex items-center gap-1.5 min-w-0">
            <Avatar className="h-4 w-4 shrink-0 opacity-90">
              <AvatarFallback className={cn('text-white text-[8px]', providerAccent(providerId))}>
                <Bot className="h-2.5 w-2.5" />
              </AvatarFallback>
            </Avatar>
            <span className="font-semibold text-foreground/60">{t('messages.assistant')}</span>
            {!group.hasText && toolCount > 0 && (
              <span className="normal-case tracking-normal opacity-70">{t('messages.toolCount', { count: toolCount })}</span>
            )}
            {tokenBadge}
          </div>
          {allText && <CopyMarkdownButton text={allText} />}
        </div>
        <div className="max-h-[60vh] overflow-y-auto">
          {group.messages.map((msg, mi) =>
            msg.content.map((b: ContentBlock, bi: number) =>
              renderAssistantBlock(
                b,
                mi * 1000 + bi,
                { onAnswer: handlers.onAnswer, onPlanResponse: handlers.onPlanResponse, onTasksResponse: handlers.onTasksResponse, onDecide: handlers.onDecide },
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
