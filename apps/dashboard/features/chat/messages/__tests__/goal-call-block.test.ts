import i18n from 'i18next';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeAll, describe, expect, it } from 'vitest';
import { bootstrapTestI18n } from '../../../../i18n/test-bootstrap.js';
import type { StreamBlock } from '../../../../hooks/agent-stream/types.js';
import type { ContentBlock, PromptHandlers, ToolResultView } from '../../types.js';
import { renderAssistantBlock } from '../MessageView.js';
import { renderStreamBlock } from '../renderStreamBlock.js';

const ERROR_TEXT = 'No goal set. Call create_goal first.';
const TOOL_ID = 'goal-update-1';

const handlers: PromptHandlers = {
  onAnswer: async () => {},
  onPlanResponse: async () => {},
  onTasksResponse: async () => {},
};

function expectFailedUpdate(html: string): void {
  expect(html).toContain('Falha ao atualizar meta');
  expect(html).not.toContain('Meta atualizada');
  expect(html).toContain('border-destructive/40');
  expect(html).toContain('text-destructive');
  expect(html).not.toContain('border-success/40');
  expect(html.match(new RegExp(ERROR_TEXT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'))).toHaveLength(1);
}

describe('GoalCallBlock error presentation', () => {
  beforeAll(bootstrapTestI18n);

  it('defines truthful failure labels in both supported locales', () => {
    expect(i18n.t('messages.goalUpdateFailed', { ns: 'chat', lng: 'en' })).toBe('Failed to update goal');
    expect(i18n.t('messages.goalUpdateFailed', { ns: 'chat', lng: 'pt-BR' })).toBe('Falha ao atualizar meta');
  });

  it('renders a live update_goal failure as one destructive error', () => {
    const block: StreamBlock = {
      type: 'tool',
      call: {
        id: TOOL_ID,
        name: 'update_goal',
        input: { status: 'complete' },
        result: { content: ERROR_TEXT, isError: true },
        status: 'error',
      },
    };

    expectFailedUpdate(renderToStaticMarkup(renderStreamBlock(block, 0, handlers)));
  });

  it('renders a persisted update_goal failure with the same truthful state', () => {
    const block: ContentBlock = {
      type: 'tool_use',
      id: TOOL_ID,
      name: 'update_goal',
      input: { status: 'complete' },
    };
    const results = new Map<string, ToolResultView>([
      [TOOL_ID, { content: ERROR_TEXT, isError: true }],
    ]);

    expectFailedUpdate(renderToStaticMarkup(
      renderAssistantBlock(block, 0, handlers, results, null),
    ));
  });

  it('continues to show a successful get_goal result', () => {
    const result = 'Status: in_progress\nGoal: Fix the renderer';
    const block: StreamBlock = {
      type: 'tool',
      call: {
        id: 'goal-read-1',
        name: 'get_goal',
        result: { content: result },
        status: 'done',
      },
    };

    const html = renderToStaticMarkup(renderStreamBlock(block, 0, handlers));
    expect(html).toContain('Meta consultada');
    expect(html).toContain('Status: in_progress');
    expect(html).toContain('Goal: Fix the renderer');
  });

  it('uses an in-progress heading while update_goal is still running', () => {
    const block: StreamBlock = {
      type: 'tool',
      call: {
        id: 'goal-running-1',
        name: 'update_goal',
        input: { status: 'complete' },
        status: 'running',
      },
    };

    const html = renderToStaticMarkup(renderStreamBlock(block, 0, handlers));
    expect(html).toContain('Atualizando meta…');
    expect(html).not.toContain('Meta atualizada');
    expect(html).toContain('animate-spin');
  });

  it('renders an explicit pivot as superseded rather than completed', () => {
    const block: StreamBlock = {
      type: 'tool',
      call: {
        id: 'goal-superseded-1',
        name: 'update_goal',
        input: {
          status: 'superseded',
          note: 'Usuário mudou o objetivo.',
        },
        result: {
          content: 'Goal superseded: Usuário mudou o objetivo.',
          isError: false,
        },
        status: 'done',
      },
    };

    const html = renderToStaticMarkup(renderStreamBlock(block, 0, handlers));
    expect(html).toContain('Meta substituída');
    expect(html).not.toContain('Meta atualizada');
    expect(html).toContain('text-muted-foreground');
  });
});
