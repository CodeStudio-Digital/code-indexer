/**
 * A gate tool (submit_tasks / submit_plan / decision_gate / …) pauses the turn
 * awaiting approval, so the live block lingers while the same tool_use is
 * checkpoint-persisted into history. On reattach both render → the card shows
 * twice. These helpers dedup the LIVE copy against persisted tool_use ids.
 */
import { describe, expect, it } from 'vitest';
import { collectPersistedToolUseIds, liveBlockPersistedId, visibleLiveBlocks } from '../utils.js';
import type { StreamBlock } from '../../../hooks/useAgentStream.js';
import type { PersistedMessage } from '../types.js';

const tasksBlock = (id: string): StreamBlock =>
  ({ type: 'tasks', tasks: { tool_use_id: id, summary: '', tasks: [], version: 1 } }) as StreamBlock;
const planBlock = (id: string): StreamBlock => ({ type: 'plan', plan: { id, plan: 'do x' } }) as StreamBlock;
const decisionBlock = (id: string): StreamBlock =>
  ({ type: 'decision', decision: { id, questions: [] } }) as StreamBlock;
const toolBlock = (id: string): StreamBlock =>
  ({ type: 'tool', call: { id, name: 'read_file', input: {}, status: 'running' } }) as StreamBlock;
const textBlock = (text: string): StreamBlock => ({ type: 'text', text });
const taskRunBlock = (runId: string): StreamBlock =>
  ({ type: 'task_run', run: { runId } }) as unknown as StreamBlock;

const assistantToolUse = (...ids: string[]): PersistedMessage => ({
  role: 'assistant',
  content: ids.map((id) => ({ type: 'tool_use', id, name: 'submit_tasks', input: {} })),
});

describe('liveBlockPersistedId', () => {
  it('maps each gate/tool block type to its persisted tool_use id', () => {
    expect(liveBlockPersistedId(tasksBlock('t1'))).toBe('t1');
    expect(liveBlockPersistedId(planBlock('p1'))).toBe('p1');
    expect(liveBlockPersistedId(decisionBlock('d1'))).toBe('d1');
    expect(liveBlockPersistedId(toolBlock('c1'))).toBe('c1');
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

  it('returns the input unchanged when nothing is persisted yet (fast path)', () => {
    const blocks = [tasksBlock('t1'), planBlock('p1')];
    expect(visibleLiveBlocks(blocks, new Set())).toBe(blocks);
  });
});
