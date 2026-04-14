import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Brain, ChevronDown, ChevronRight } from 'lucide-react';
import type { StreamBlock } from '../../../hooks/useAgentStream.js';
import { PlanPromptView } from '../prompts/PlanPromptView.js';
import { QuestionPromptView } from '../prompts/QuestionPromptView.js';
import { TaskListReview } from '../prompts/TaskListReview.js';
import type { PromptHandlers } from '../types.js';
import { AgentsGroupBlock } from './AgentsGroupBlock.js';
import { Markdown } from './Markdown.js';
import { ToolCallBlock } from './ToolCallBlock.js';

function LiveThinkingBlock({ text }: { text: string }) {
  const { t } = useTranslation('chat');
  const [open, setOpen] = useState(true);
  return (
    <div className="my-1">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
      >
        <Brain className="h-3.5 w-3.5 animate-pulse" />
        {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        <span className="font-medium">{t('messages.thinking')}</span>
      </button>
      {open && (
        <div className="mt-1 ml-5 rounded-lg border border-dashed bg-muted/30 px-3 py-2 text-xs text-muted-foreground italic whitespace-pre-wrap max-h-[40vh] overflow-y-auto">
          {text}
        </div>
      )}
    </div>
  );
}

export function renderStreamBlock(block: StreamBlock, key: number, handlers: PromptHandlers) {
  if (block.type === 'thinking') {
    return <LiveThinkingBlock key={`th-${key}`} text={block.text} />;
  }
  if (block.type === 'text') {
    return (
      <div key={`t-${key}`} className="text-sm text-foreground/90">
        <Markdown text={block.text} />
      </div>
    );
  }
  if (block.type === 'tool') {
    return <ToolCallBlock key={`tc-${block.call.id}`} call={block.call} />;
  }
  if (block.type === 'plan') {
    return <PlanPromptView key={`pl-${block.plan.id}`} plan={block.plan} onResponse={handlers.onPlanResponse} />;
  }
  if (block.type === 'tasks') {
    return (
      <TaskListReview
        key={`tl-${block.tasks.tool_use_id}`}
        prompt={block.tasks}
        onResponse={handlers.onTasksResponse}
      />
    );
  }
  if (block.type === 'agents') {
    return <AgentsGroupBlock key={`ag-${block.group.groupId}`} group={block.group} />;
  }
  return (
    <QuestionPromptView key={`qq-${block.question.id}`} question={block.question} onAnswer={handlers.onAnswer} />
  );
}
