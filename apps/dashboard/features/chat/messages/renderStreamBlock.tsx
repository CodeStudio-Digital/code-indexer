import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertCircle, Brain, ChevronDown, ChevronRight, Sparkles } from 'lucide-react';
import type { PreThinkStreamBlock, StreamBlock } from '../../../hooks/agent-stream/types.js';
import { PlanPromptView } from '../prompts/PlanPromptView.js';
import { SpecPromptView } from '../prompts/SpecPromptView.js';
import { QuestionPromptView } from '../prompts/QuestionPromptView.js';
import { TaskListReview } from '../prompts/TaskListReview.js';
import type { PromptHandlers } from '../types.js';
import { AgentsGroupBlock } from './AgentsGroupBlock.js';
import { Markdown } from './Markdown.js';
import { TaskExecutionBlock } from './TaskExecutionBlock.js';
import { ToolCallBlock } from './ToolCallBlock.js';
import { GoalCallBlock, isGoalTool } from './GoalCallBlock.js';
import { ActivityLineBlock } from './ActivityLineBlock.js';

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

/**
 * Simulated deepThink block — a pre-thought written by an auxiliary cheap
 * model BEFORE the main-model turn. Visually distinct from the native
 * `thinking` block (emerald + Sparkles vs muted + Brain) so the user can
 * tell at a glance which model is reasoning.
 *
 * States:
 *   streaming → pulsing Sparkles, "Pré-pensando (model/provider)…"
 *   done      → static Sparkles, "Pré-pensamento (model/provider)"
 *   failed    → AlertCircle, "deepThink falhou: <error>" (no body, no badge)
 */
function LivePreThinkBlock({ block }: { block: PreThinkStreamBlock }) {
  const [open, setOpen] = useState(true);

  if (block.status === 'failed') {
    return (
      <div className="my-1 ml-0">
        <div className="flex items-start gap-1.5 text-xs text-amber-600 dark:text-amber-400">
          <AlertCircle className="h-3.5 w-3.5 flex-shrink-0 mt-0.5" />
          <div>
            <span className="font-medium">deepThink falhou</span>
            <span className="ml-1 font-mono opacity-80">({block.provider}/{block.model})</span>
            {block.error && (
              <div className="mt-0.5 text-[11px] opacity-90">{block.error}</div>
            )}
          </div>
        </div>
      </div>
    );
  }

  const streaming = block.status === 'streaming';
  return (
    <div className="my-1">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 text-xs text-emerald-600 dark:text-emerald-400 hover:text-emerald-700 dark:hover:text-emerald-300 transition-colors"
      >
        <Sparkles className={`h-3.5 w-3.5 ${streaming ? 'animate-pulse' : ''}`} />
        {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        <span className="font-medium">{streaming ? 'Pré-pensando…' : 'Pré-pensamento'}</span>
        <span className="ml-0.5 px-1.5 py-0.5 rounded text-[10px] font-mono bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border border-emerald-500/20">
          {block.provider}/{block.model}
        </span>
      </button>
      {open && block.text && (
        <div className="mt-1 ml-5 rounded-lg border border-dashed border-emerald-500/30 bg-emerald-500/[0.04] px-3 py-2 text-xs text-emerald-900 dark:text-emerald-200 italic whitespace-pre-wrap max-h-[40vh] overflow-y-auto">
          {block.text}
        </div>
      )}
    </div>
  );
}

export function renderStreamBlock(block: StreamBlock, key: number, handlers: PromptHandlers) {
  if (block.type === 'thinking') {
    return <LiveThinkingBlock key={`th-${key}`} text={block.text} />;
  }
  if (block.type === 'pre_think') {
    return <LivePreThinkBlock key={`pt-${key}`} block={block} />;
  }
  if (block.type === 'activity') {
    return <ActivityLineBlock key={`act-${block.id}`} activity={block} />;
  }
  if (block.type === 'text') {
    return (
      <div key={`t-${key}`} className="text-sm text-foreground/90">
        <Markdown text={block.text} />
      </div>
    );
  }
  if (block.type === 'tool') {
    if (isGoalTool(block.call.name)) {
      return <GoalCallBlock key={`tc-${block.call.id}`} call={block.call} />;
    }
    return <ToolCallBlock key={`tc-${block.call.id}`} call={block.call} />;
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
  return (
    <QuestionPromptView key={`qq-${block.question.id}`} question={block.question} onAnswer={handlers.onAnswer} />
  );
}
