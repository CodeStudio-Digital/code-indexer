import type { StreamBlock } from '../../../hooks/useAgentStream.js';
import { PlanPromptView } from '../prompts/PlanPromptView.js';
import { QuestionPromptView } from '../prompts/QuestionPromptView.js';
import { TaskListReview } from '../prompts/TaskListReview.js';
import type { PromptHandlers } from '../types.js';
import { Markdown } from './Markdown.js';
import { ToolCallBlock } from './ToolCallBlock.js';

export function renderStreamBlock(block: StreamBlock, key: number, handlers: PromptHandlers) {
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
  return (
    <QuestionPromptView key={`qq-${block.question.id}`} question={block.question} onAnswer={handlers.onAnswer} />
  );
}
