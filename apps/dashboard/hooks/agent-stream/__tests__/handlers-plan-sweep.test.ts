/**
 * Resolved-plan sweep. The `plan` card lands in the live buffer AFTER its
 * turn's message_complete, so the per-turn clear never removes it and it used
 * to stay pinned above the NEXT turn's streaming content ("thinking below its
 * own plan"). The runner only resumes after the plan is resolved, so the
 * first streamed content of the next turn sweeps the card and triggers the
 * history refetch (the persisted row renders the resolved card instead).
 */
import { describe, expect, it, vi } from 'vitest';
import { createEventHandlers } from '../handlers.js';
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

describe('resolved-plan sweep', () => {
  it('the next turn\'s thinking sweeps the plan card and refetches history', () => {
    const { handlers, blocks, onMessageComplete } = setup();
    handlers.plan({ id: 'p1', plan: 'Diagnóstico...' }, 'plan');
    expect(types(blocks)).toEqual(['plan']);

    handlers.thinking({ text: 'analisando...' }, 'thinking');
    expect(types(blocks)).toEqual(['thinking']);
    expect(onMessageComplete).toHaveBeenCalledTimes(1);
  });

  it('text and tool_call_start also sweep, and the tool index stays coherent', () => {
    const { handlers, blocks, toolIndex } = setup();
    handlers.plan({ id: 'p1', plan: 'x' }, 'plan');
    handlers.tool_call_start({ id: 't1', name: 'read_file' }, 'tool_call_start');
    expect(types(blocks)).toEqual(['tool']);
    // Post-splice index must point at the tool's ACTUAL position.
    expect(toolIndex.get('t1')).toBe(0);

    const { handlers: h2, blocks: b2 } = setup();
    h2.plan({ id: 'p2', plan: 'y' }, 'plan');
    h2.text({ text: 'resposta' }, 'text');
    expect(types(b2)).toEqual(['text']);
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
    handlers.text({ text: '' }, 'text');
    handlers.thinking({ text: '' }, 'thinking');
    expect(types(blocks)).toEqual(['plan']);
  });
});
