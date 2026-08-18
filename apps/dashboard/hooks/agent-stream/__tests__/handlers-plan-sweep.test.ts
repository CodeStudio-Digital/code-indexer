/**
 * Resolved-interaction sweep. Rich prompt cards land in the run-level live
 * buffer after message_complete and must survive while input is pending. Once
 * the user answers, the first streamed content of the next provider cycle
 * sweeps the card and triggers the history refetch (the persisted row renders
 * the resolved card instead).
 *
 * The sweep is gated on the ANSWER, not merely on new content arriving: the
 * persisted checkpoint that replaces a swept card is written asynchronously, so
 * sweeping an unanswered prompt could leave it gone from both sides.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEventHandlers } from '../handlers.js';
import {
  markPromptResolved,
  resetPromptResolutions,
} from '../prompt-resolution-store.js';
import type { StreamBlock, UpdateSession } from '../types.js';

function setup() {
  const blocks: StreamBlock[] = [];
  const toolIndex = new Map<string, number>();
  const flush = vi.fn();
  const flushNow = vi.fn();
  const updateSession: UpdateSession = vi.fn();
  const onMessageComplete = vi.fn();
  const handlers = createEventHandlers({
    sid: 1,
    blocks,
    toolIndex,
    flush,
    flushNow,
    updateSession,
    onMessageComplete,
  });
  return { handlers, blocks, toolIndex, onMessageComplete };
}

const types = (blocks: StreamBlock[]): string[] => blocks.map((b) => b.type);

afterEach(() => resetPromptResolutions());

describe('resolved-interaction sweep', () => {
  it("the next turn's thinking sweeps an ANSWERED plan card and refetches history", () => {
    const { handlers, blocks, onMessageComplete } = setup();
    handlers.plan({ id: 'p1', plan: 'Diagnóstico...' }, 'plan');
    expect(types(blocks)).toEqual(['plan']);
    markPromptResolved({ id: 'p1', resolution: 'approved' });

    handlers.thinking({ text: 'analisando...' }, 'thinking');
    expect(types(blocks)).toEqual(['thinking']);
    expect(onMessageComplete).toHaveBeenCalledTimes(1);
  });

  it('sweeps every answered rich card before rendering the resumed turn', () => {
    const { handlers, blocks, onMessageComplete } = setup();
    handlers.question({ id: 'q1', question: 'Scope?' }, 'question');
    handlers.decision({
      id: 'd1',
      questions: [{ id: 'strategy', question: 'Strategy?', options: [] }],
    }, 'decision');
    handlers.tasks_posted({ tool_use_id: 't1', summary: 'Tasks', tasks: [], version: 1 }, 'tasks_posted');
    handlers.spec({ id: 's1', name: 'Spec', body: '# Spec', spec_path: 'spec.md' }, 'spec');
    expect(types(blocks)).toEqual(['question', 'decision', 'tasks', 'spec']);

    for (const id of ['q1', 'd1', 't1', 's1']) markPromptResolved({ id, resolution: 'answered' });
    handlers.thinking({ text: 'resuming...' }, 'thinking');
    expect(types(blocks)).toEqual(['thinking']);
    expect(onMessageComplete).toHaveBeenCalledTimes(1);
  });

  it('text and tool_call_start also sweep, and the tool index stays coherent', () => {
    const { handlers, blocks, toolIndex } = setup();
    handlers.plan({ id: 'p1', plan: 'x' }, 'plan');
    markPromptResolved({ id: 'p1', resolution: 'approved' });
    handlers.tool_call_start({ id: 't1', name: 'read_file' }, 'tool_call_start');
    expect(types(blocks)).toEqual(['tool']);
    // Post-splice index must point at the tool's ACTUAL position.
    expect(toolIndex.get('t1')).toBe(0);

    const { handlers: h2, blocks: b2 } = setup();
    h2.plan({ id: 'p2', plan: 'y' }, 'plan');
    markPromptResolved({ id: 'p2', resolution: 'approved' });
    h2.text({ text: 'resposta' }, 'text');
    expect(types(b2)).toEqual(['text']);
  });

  it('an UNANSWERED card survives new content instead of vanishing', () => {
    const { handlers, blocks, onMessageComplete } = setup();
    handlers.question({ id: 'q1', question: 'Scope?' }, 'question');

    // Text arriving while the prompt is still open is not proof it was answered.
    handlers.text({ text: 'still working' }, 'text');
    handlers.tool_call_start({ id: 't9', name: 'read_file' }, 'tool_call_start');

    expect(types(blocks)).toContain('question');
    expect(onMessageComplete).not.toHaveBeenCalled();
  });

  it('sweeps only the answered card and leaves the pending one alone', () => {
    const { handlers, blocks } = setup();
    handlers.question({ id: 'q1', question: 'First?' }, 'question');
    handlers.decision({
      id: 'd1',
      questions: [{ id: 'strategy', question: 'Strategy?', options: [] }],
    }, 'decision');
    markPromptResolved({ id: 'q1', resolution: 'yes' });

    handlers.text({ text: 'resumed' }, 'text');

    expect(types(blocks)).toEqual(['decision', 'text']);
  });

  it('the plan card SURVIVES while pending — no sweep without new-turn content', () => {
    const { handlers, blocks, onMessageComplete } = setup();
    handlers.plan({ id: 'p1', plan: 'x' }, 'plan');
    // Resolution-adjacent events that are NOT proof of a resumed turn.
    handlers.tool_call_result({ id: 'plan-tool', content: 'Plan approved by user.' }, 'tool_call_result');
    handlers.context_status({ turn: 3, prompt_tokens: 100, source: 'usage', context_window: 1000, ratio: 0.1 }, 'context_status');
    expect(types(blocks)).toContain('plan');
    expect(onMessageComplete).not.toHaveBeenCalled();
  });

  it('empty deltas never sweep (keep-alive noise while parked)', () => {
    const { handlers, blocks } = setup();
    handlers.plan({ id: 'p1', plan: 'x' }, 'plan');
    markPromptResolved({ id: 'p1', resolution: 'approved' });
    handlers.text({ text: '' }, 'text');
    handlers.thinking({ text: '' }, 'thinking');
    expect(types(blocks)).toEqual(['plan']);
  });
});
