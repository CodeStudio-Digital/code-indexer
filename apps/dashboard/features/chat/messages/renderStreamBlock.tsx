import type { StreamBlock } from '../../../hooks/agent-stream/types.js';
import { PlanPromptView } from '../prompts/PlanPromptView.js';
import { SpecPromptView } from '../prompts/SpecPromptView.js';
import { QuestionPromptView } from '../prompts/QuestionPromptView.js';
import { DecisionGateView } from '../prompts/DecisionGateView.js';
import { TaskListReview } from '../prompts/TaskListReview.js';
import type { PromptHandlers } from '../types.js';
import { AgentsGroupBlock } from './AgentsGroupBlock.js';
import { LiveTextBlock, LiveThinkingBlock } from './live-blocks.js';
import { TaskExecutionBlock } from './TaskExecutionBlock.js';
import { ToolCallBlock } from './ToolCallBlock.js';
import { TodoWriteBlock } from './TodoWriteBlock.js';
import { taskListIsApprove } from './MessageView.js';
import { SelfReviewBlock } from './SelfReviewBlock.js';
import { GoalCallBlock, isGoalTool } from './GoalCallBlock.js';
import { FileEditBlock } from './FileEditBlock.js';
import { isEditTool } from './edit-tools.js';
import { ActivityLineBlock } from '../../../components/stream/ActivityLineBlock.js';

export function renderStreamBlock(block: StreamBlock, key: number, handlers: PromptHandlers) {
  if (block.type === 'thinking') {
    return <LiveThinkingBlock key={`th-${block.id ?? key}`} text={block.text} />;
  }
  if (block.type === 'activity') {
    return <ActivityLineBlock key={`act-${block.id}`} activity={block} />;
  }
  if (block.type === 'text') {
    return <LiveTextBlock key={`t-${block.id ?? key}`} text={block.text} />;
  }
  if (block.type === 'tool') {
    if (isGoalTool(block.call.name)) {
      return <GoalCallBlock key={`tc-${block.call.id}`} call={block.call} />;
    }
    // todo_write / update_todo / task_list(track): render the checklist inside
    // the collapsed tool block (consistent with the historical transcript)
    // instead of raw JSON. task_list(approve) is handled by the approval prompt,
    // not here.
    if (
      (block.call.name === 'todo_write' ||
        block.call.name === 'update_todo' ||
        (block.call.name === 'task_list' && !taskListIsApprove(block.call.input))) &&
      block.call.result &&
      !block.call.result.isError
    ) {
      return (
        <ToolCallBlock key={`tc-${block.call.id}`} call={block.call} onToolApproval={handlers.onToolApproval}>
          <TodoWriteBlock text={block.call.result.content} />
        </ToolCallBlock>
      );
    }
    // self_review / review_subordinate_work: render the findings list.
    if (
      (block.call.name === 'self_review' || block.call.name === 'review_subordinate_work') &&
      block.call.result &&
      !block.call.result.isError
    ) {
      return (
        <ToolCallBlock key={`tc-${block.call.id}`} call={block.call} onToolApproval={handlers.onToolApproval}>
          <SelfReviewBlock text={block.call.result.content} />
        </ToolCallBlock>
      );
    }
    // edit_file / multi_edit / write_file / create_file / apply_patch: render a
    // file-first block (files + inline diffs) instead of raw tool JSON.
    if (isEditTool(block.call.name)) {
      return (
        <FileEditBlock
          key={`tc-${block.call.id}`}
          call={block.call}
          onToolApproval={handlers.onToolApproval}
        />
      );
    }
    return <ToolCallBlock key={`tc-${block.call.id}`} call={block.call} onToolApproval={handlers.onToolApproval} />;
  }
  if (block.type === 'plan') {
    return <PlanPromptView key={`pl-${block.plan.id}`} plan={block.plan} onResponse={handlers.onPlanResponse} />;
  }
  if (block.type === 'spec') {
    return (
      <SpecPromptView
        key={`sp-${block.spec.id}`}
        spec={block.spec}
        onResponse={
          handlers.onSpecResponse ??
          (async () => {
            /* no-op when the host did not wire onSpecResponse — keeps UI tolerant */
          })
        }
      />
    );
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
  if (block.type === 'task_run') {
    return <TaskExecutionBlock key={`tr-${block.run.runId}`} run={block.run} />;
  }
  if (block.type === 'agents') {
    return <AgentsGroupBlock key={`ag-${block.group.groupId}`} group={block.group} />;
  }
  if (block.type === 'decision') {
    return (
      <DecisionGateView
        key={`dg-${block.decision.id}`}
        decision={block.decision}
        onConfirm={handlers.onDecide ?? (async () => { /* no-op when unwired */ })}
      />
    );
  }
  return (
    <QuestionPromptView key={`qq-${block.question.id}`} question={block.question} onAnswer={handlers.onAnswer} />
  );
}
