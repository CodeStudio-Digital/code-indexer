/**
 * A gate tool (submit_tasks / submit_plan / decision_gate / …) pauses the turn
 * awaiting approval, so the live block lingers while the same tool_use is
 * checkpoint-persisted into history. On reattach both render → the card shows
 * twice. These helpers dedup the LIVE copy against persisted tool_use ids.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeAll, describe, expect, it } from 'vitest';
import { bootstrapTestI18n } from '../../../i18n/test-bootstrap.js';
import {
  collectLatestPersistedInteractivePromptSignatures,
  collectPersistedToolUseIds,
  isLiveTurnDuplicatedInHistory,
  liveBlockPersistedId,
  visibleLiveBlocks,
} from '../utils.js';
import type { StreamBlock } from '../../../hooks/useAgentStream.js';
import {
  buildDecisionAnswers,
  decisionQuestionHasAnswer,
  DecisionGateView,
} from '../prompts/DecisionGateView.js';
import type { DecisionPrompt, DecisionQuestion } from '../../../hooks/agent-stream/types.js';
import type { PersistedMessage } from '../types.js';

const approvalTasks = [
  {
    id: 'tsk_1',
    title: 'Map interactive prompts',
    description: 'Find prompts that pause for user input',
    files: ['apps/dashboard/features/chat/utils.ts'],
    references: [],
    depends_on: [],
    suggested_mode: 'inline',
    estimated_complexity: 'small',
  },
];
const tasksBlock = (id: string): StreamBlock =>
  ({ type: 'tasks', tasks: { tool_use_id: id, summary: '', tasks: [], version: 1 } }) as StreamBlock;
const approvalTasksBlock = (id: string): StreamBlock =>
  ({
    type: 'tasks',
    tasks: { tool_use_id: id, summary: 'Approve these tasks', tasks: approvalTasks, version: 1 },
  }) as unknown as StreamBlock;
const planBlock = (id: string): StreamBlock => ({ type: 'plan', plan: { id, plan: 'do x' } }) as StreamBlock;
const roadmapPlanBlock = (id: string): StreamBlock =>
  ({ type: 'plan', plan: { id, plan: '1. Map prompts\n2. Fix dedup', kind: 'mutating' } }) as StreamBlock;
const questionBlock = (id: string): StreamBlock =>
  ({
    type: 'question',
    question: {
      id,
      header: 'Scope',
      question: 'Which scope should I use?',
      options: [{ label: 'Focused', value: 'focused' }, { label: 'Broad', value: 'broad' }],
      allowFreeform: true,
    },
  }) as StreamBlock;
const specBlock = (id: string): StreamBlock =>
  ({
    type: 'spec',
    spec: { id, name: 'Chat dedup', body: '# Spec\nFix prompt dedup.', spec_path: '.mcp/specs/chat-dedup.md' },
  }) as StreamBlock;
const decisionBlock = (id: string): StreamBlock =>
  ({ type: 'decision', decision: { id, questions: [] } }) as StreamBlock;
const roadmapDecisionBlock = (id: string): StreamBlock =>
  ({
    type: 'decision',
    decision: {
      id,
      header: 'Estratégia do roadmap',
      allowFreeform: true,
      questions: [
        {
          id: 'strategy',
          question: 'Qual estratégia de evolução você prefere para o code-agent?',
          options: [
            { label: 'Incremental medida', value: 'incremental' },
            { label: 'Runtime guardrails', value: 'guardrails' },
            { label: 'Evals primeiro', value: 'evals' },
            { label: 'Rework profundo', value: 'rework' },
          ],
        },
      ],
    },
  }) as StreamBlock;
const toolBlock = (id: string): StreamBlock =>
  ({ type: 'tool', call: { id, name: 'read_file', input: {}, status: 'running' } }) as StreamBlock;
const textBlock = (text: string): StreamBlock => ({ type: 'text', text });
const taskRunBlock = (runId: string): StreamBlock =>
  ({ type: 'task_run', run: { runId } }) as unknown as StreamBlock;
const agentsBlock = (groupId: string, toolUseId?: string): StreamBlock => ({
  type: 'agents',
  group: {
    groupId,
    toolUseId,
    status: 'running',
    agents: [{ index: 0, label: 'Scout', status: 'running', toolCallCount: 1 }],
  },
});

const assistantToolUse = (...ids: string[]): PersistedMessage => ({
  role: 'assistant',
  content: ids.map((id) => ({ type: 'tool_use', id, name: 'submit_tasks', input: {} })),
});
const assistantText = (text: string): PersistedMessage => ({
  role: 'assistant',
  content: [{ type: 'text', text }],
});
const assistantTextAndTool = (text: string, id: string): PersistedMessage => ({
  role: 'assistant',
  content: [{ type: 'text', text }, { type: 'tool_use', id, name: 'submit_tasks', input: {} }],
});
const assistantTextAndInteractiveTool = (text: string, id: string, name: string, input: Record<string, unknown>): PersistedMessage => ({
  role: 'assistant',
  content: [{ type: 'text', text }, { type: 'tool_use', id, name, input }],
});
const planInput = { plan: '1. Map prompts\n2. Fix dedup', kind: 'mutating' };
const questionInput = {
  header: 'Scope',
  question: 'Which scope should I use?',
  options: [{ label: 'Focused', value: 'focused' }, { label: 'Broad', value: 'broad' }],
  allow_freeform: true,
};
const specInput = { name: 'Chat dedup', body: '# Spec\nFix prompt dedup.' };
const tasksInput = { summary: 'Approve these tasks', tasks: approvalTasks };
const assistantTextAndDecisionGate = (text: string, id: string): PersistedMessage => ({
  role: 'assistant',
  content: [
    { type: 'text', text },
    {
      type: 'tool_use',
      id,
      name: 'decision_gate',
      input: {
        header: 'Estratégia do roadmap',
        allow_freeform: true,
        questions: [
          {
            id: 'strategy',
            question: 'Qual estratégia de evolução você prefere para o code-agent?',
            options: [
              { label: 'Incremental medida', value: 'incremental' },
              { label: 'Runtime guardrails', value: 'guardrails' },
              { label: 'Evals primeiro', value: 'evals' },
              { label: 'Rework profundo', value: 'rework' },
            ],
          },
        ],
      },
    },
  ],
});

describe('liveBlockPersistedId', () => {
  it('maps each gate/tool block type to its persisted tool_use id', () => {
    expect(liveBlockPersistedId(tasksBlock('t1'))).toBe('t1');
    expect(liveBlockPersistedId(planBlock('p1'))).toBe('p1');
    expect(liveBlockPersistedId(decisionBlock('d1'))).toBe('d1');
    expect(liveBlockPersistedId(toolBlock('c1'))).toBe('c1');
    expect(liveBlockPersistedId(agentsBlock('g1', 'spawn-1'))).toBe('spawn-1');
  });

  it('returns undefined for live-only visualizations (no persisted identity)', () => {
    expect(liveBlockPersistedId(textBlock('hi'))).toBeUndefined();
    expect(liveBlockPersistedId(taskRunBlock('r1'))).toBeUndefined();
  });
});

describe('collectPersistedToolUseIds', () => {
  it('gathers only assistant tool_use ids', () => {
    const ids = collectPersistedToolUseIds([
      { role: 'user', content: [{ type: 'text', text: 'go' }] },
      assistantToolUse('a', 'b'),
      // a tool_result message carries tool_use_id, NOT a tool_use id → excluded
      { role: 'tool', content: [{ type: 'tool_result', tool_use_id: 'a', content: 'ok' }] },
    ]);
    expect([...ids].sort()).toEqual(['a', 'b']);
  });

  it('is empty for a session with no persisted tool calls', () => {
    expect(collectPersistedToolUseIds([{ role: 'assistant', content: [{ type: 'text', text: 'hi' }] }]).size).toBe(0);
  });
});

describe('visibleLiveBlocks', () => {
  it('drops a gate block whose id is already persisted (the dup case)', () => {
    const persisted = collectPersistedToolUseIds([assistantToolUse('t1')]);
    const out = visibleLiveBlocks([tasksBlock('t1')], persisted);
    expect(out).toHaveLength(0); // persisted card is canonical; live copy suppressed
  });

  it('keeps a gate block whose id is NOT yet persisted (first live submit)', () => {
    const out = visibleLiveBlocks([tasksBlock('fresh')], collectPersistedToolUseIds([]));
    expect(out).toHaveLength(1);
  });

  it('keeps live-only blocks (text / task_run) even when other ids are persisted', () => {
    const persisted = collectPersistedToolUseIds([assistantToolUse('t1')]);
    const out = visibleLiveBlocks([textBlock('streaming…'), taskRunBlock('r1'), tasksBlock('t1')], persisted);
    expect(out.map((b) => b.type)).toEqual(['text', 'task_run']);
  });

  it('drops a live decision_gate when the latest persisted turn has the same prompt but a different tool_use id', () => {
    const persisted = [
      assistantTextAndDecisionGate(
        'Vou pedir uma escolha estratégica única para calibrar o roadmap antes do plano final.',
        'toolu_123',
      ),
    ];
    const signatures = collectLatestPersistedInteractivePromptSignatures(persisted);

    expect(visibleLiveBlocks([roadmapDecisionBlock('dg_live_456')], new Set(), signatures)).toEqual([]);
  });

  it('drops all interactive prompts when the latest persisted turn has the same prompt but a different tool_use id', () => {
    const cases: Array<[StreamBlock, PersistedMessage]> = [
      [roadmapPlanBlock('plan_live'), assistantTextAndInteractiveTool('Please review', 'toolu_plan', 'submit_plan', planInput)],
      [questionBlock('q_live'), assistantTextAndInteractiveTool('Need input', 'toolu_ask', 'ask_user', questionInput)],
      [specBlock('spec_live'), assistantTextAndInteractiveTool('Review spec', 'toolu_spec', 'submit_spec', specInput)],
      [approvalTasksBlock('tasks_live'), assistantTextAndInteractiveTool('Review tasks', 'toolu_tasks', 'submit_tasks', tasksInput)],
      [approvalTasksBlock('task_list_live'), assistantTextAndInteractiveTool('Review tasks', 'toolu_task_list', 'task_list', { gate: 'approve', ...tasksInput })],
    ];

    for (const [live, persisted] of cases) {
      const signatures = collectLatestPersistedInteractivePromptSignatures([persisted]);
      expect(visibleLiveBlocks([live], new Set(), signatures)).toEqual([]);
    }
  });

  it('returns the input unchanged when nothing is persisted yet (fast path)', () => {
    const blocks = [tasksBlock('t1'), planBlock('p1')];
    expect(visibleLiveBlocks(blocks, new Set())).toBe(blocks);
  });

  it('prefers the rich live agents card over its generic spawn wrapper and persisted id', () => {
    const live = agentsBlock('g1', 'spawn-1');
    const wrapper = ({
      type: 'tool',
      call: { id: 'spawn-1', name: 'spawn_agent', status: 'running' },
    }) as StreamBlock;

    expect(visibleLiveBlocks([wrapper, live], new Set(['spawn-1']))).toEqual([live]);
  });

  it('shows execute_tasks only through its rich task run representation', () => {
    const wrapper = ({
      type: 'tool',
      call: { id: 'execute-1', name: 'execute_tasks', status: 'running' },
    }) as StreamBlock;
    const run = taskRunBlock('run-1');

    expect(visibleLiveBlocks([wrapper, run], new Set())).toEqual([run]);
  });
});

describe('isLiveTurnDuplicatedInHistory', () => {
  it('detects a text-only live turn already persisted as the last assistant message', () => {
    expect(
      isLiveTurnDuplicatedInHistory(
        { blocks: [textBlock('final answer')] },
        [assistantText('final answer')],
      ),
    ).toBe(true);
  });

  it('detects a gate-only paused turn already persisted by tool_use id', () => {
    expect(
      isLiveTurnDuplicatedInHistory(
        { blocks: [decisionBlock('d1')] },
        [assistantToolUse('d1')],
      ),
    ).toBe(true);
  });

  it('detects a mixed text + gate turn only when both parts are already persisted', () => {
    expect(
      isLiveTurnDuplicatedInHistory(
        { blocks: [textBlock('review this plan'), tasksBlock('t1')] },
        [assistantTextAndTool('review this plan', 't1')],
      ),
    ).toBe(true);

    expect(
      isLiveTurnDuplicatedInHistory(
        { blocks: [textBlock('review this plan'), tasksBlock('fresh')] },
        [assistantTextAndTool('review this plan', 't1')],
      ),
    ).toBe(false);
  });

  it('detects live interactive prompts already persisted as matching prompts even when ids differ', () => {
    const cases: Array<[StreamBlock, PersistedMessage]> = [
      [roadmapDecisionBlock('dg_live_456'), assistantTextAndDecisionGate('Vou pedir uma escolha estratégica única para calibrar o roadmap antes do plano final.', 'toolu_123')],
      [roadmapPlanBlock('plan_live'), assistantTextAndInteractiveTool('Please review', 'toolu_plan', 'submit_plan', planInput)],
      [questionBlock('q_live'), assistantTextAndInteractiveTool('Need input', 'toolu_ask', 'ask_user', questionInput)],
      [specBlock('spec_live'), assistantTextAndInteractiveTool('Review spec', 'toolu_spec', 'submit_spec', specInput)],
      [approvalTasksBlock('tasks_live'), assistantTextAndInteractiveTool('Review tasks', 'toolu_tasks', 'submit_tasks', tasksInput)],
      [approvalTasksBlock('task_list_live'), assistantTextAndInteractiveTool('Review tasks', 'toolu_task_list', 'task_list', { gate: 'approve', ...tasksInput })],
    ];

    for (const [live, persisted] of cases) {
      expect(isLiveTurnDuplicatedInHistory({ blocks: [live] }, [persisted])).toBe(true);
    }
  });

  it('keeps live-only visualizations visible because they have no persisted identity', () => {
    expect(
      isLiveTurnDuplicatedInHistory(
        { blocks: [textBlock('done'), taskRunBlock('r1')] },
        [assistantText('done')],
      ),
    ).toBe(false);
  });

  it('keeps a rich live agents turn canonical after its spawn tool_use checkpoints', () => {
    expect(
      isLiveTurnDuplicatedInHistory(
        { blocks: [agentsBlock('group-1', 'spawn-1')] },
        [assistantToolUse('spawn-1')],
      ),
    ).toBe(false);
  });
});

const decisionQ1: DecisionQuestion = {
  id: 'architecture',
  header: 'Architecture',
  question: 'Where should the logic live?',
  options: [
    { label: 'Frontend', value: 'frontend', summary: 'Keep it in the UI', tradeoffs: 'Fast, but local.' },
    { label: 'Backend', value: 'backend', summary: 'Centralize on the server', tradeoffs: 'Robust, but broader.' },
  ],
};
const decisionQ2: DecisionQuestion = {
  id: 'scope',
  header: 'Scope',
  question: 'How far should we migrate?',
  multiSelect: true,
  options: [{ label: 'Tests', value: 'tests' }, { label: 'Docs', value: 'docs' }],
};
const decisionPrompt: DecisionPrompt = {
  id: 'dg-1',
  header: 'Choose implementation direction',
  allowFreeform: true,
  questions: [decisionQ1, decisionQ2],
};

function renderDecision(decision: DecisionPrompt): string {
  return renderToStaticMarkup(
    createElement(DecisionGateView, { decision, onConfirm: async () => undefined }),
  );
}

describe('DecisionGateView wizard', () => {
  beforeAll(bootstrapTestI18n);

  it('treats a custom answer as a complete answer when freeform is allowed', () => {
    expect(decisionQuestionHasAnswer(decisionQ1, {}, { architecture: 'Hand-roll a hybrid' }, true)).toBe(true);
    expect(decisionQuestionHasAnswer(decisionQ1, {}, { architecture: 'Hand-roll a hybrid' }, false)).toBe(false);
  });

  it('preserves multi-select values and freeform-only answers in the backend payload shape', () => {
    expect(
      buildDecisionAnswers(
        [decisionQ1, decisionQ2],
        { scope: ['tests', 'docs'] },
        { architecture: 'Use a staged migration', scope: 'Include smoke tests' },
      ),
    ).toEqual({
      architecture: { selected: [], freeform: 'Use a staged migration' },
      scope: { selected: ['tests', 'docs'], freeform: 'Include smoke tests' },
    });
  });

  it('renders one pending question at a time with step navigation controls', () => {
    const html = renderDecision(decisionPrompt);
    expect(html).toContain('Choose implementation direction');
    expect(html).toContain('Where should the logic live?');
    expect(html).not.toContain('How far should we migrate?');
    expect(html).toMatch(/Etapa 1 de 2|Step 1 of 2|decision\.stepLabel/);
    expect(html).toMatch(/Voltar|Back|decision\.back/);
    expect(html).toMatch(/Avançar|Next|decision\.next/);
    expect(html).toMatch(/Digite sua própria resposta|Type your own answer|decision\.answerPlaceholder/);
  });

  it('renders a read-only summary when resolved', () => {
    const html = renderDecision({
      ...decisionPrompt,
      resolved: {
        architecture: { selected: [], freeform: 'Use a staged migration' },
        scope: { selected: ['tests', 'docs'] },
      },
    });
    expect(html).toMatch(/Resumo das decisões|Decision summary|decision\.summary/);
    expect(html).toContain('Use a staged migration');
    expect(html).toContain('Tests, Docs');
    expect(html).toContain('Where should the logic live?');
    expect(html).toContain('How far should we migrate?');
  });
});
