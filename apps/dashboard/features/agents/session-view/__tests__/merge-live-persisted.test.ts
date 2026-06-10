/**
 * The board + agents lists must MERGE the persisted REST snapshot with the
 * live SSE stream. Rendering either source exclusively was the bug: the
 * board collapsed to "the latest" and agents disappeared the instant the
 * first live event arrived.
 */
import { describe, it, expect } from 'vitest';
import { mergeBoardMessages, mergeSubordinates } from '../merge-live-persisted.js';
import type { AgentStreamState, BoardMessage } from '../../../../state/company/types.js';
import type { PersistedAgentRun } from '../types.js';

const board = (id: number, content: string): BoardMessage => ({
  id,
  author_role: 'system',
  agent_run_id: null,
  kind: 'message',
  content,
  mentions: [],
  created_at: `2026-01-01T00:00:0${id}Z`,
});

describe('mergeBoardMessages', () => {
  it('keeps persisted history AND appends live, deduped by id (live wins)', () => {
    const merged = mergeBoardMessages(
      [board(1, 'old-1'), board(2, 'old-2')],
      [board(2, 'live-2'), board(3, 'live-3')],
    );
    expect(merged.map((m) => m.id).sort((a, b) => a - b)).toEqual([1, 2, 3]);
    expect(merged.find((m) => m.id === 2)?.content).toBe('live-2'); // live wins
    expect(merged.find((m) => m.id === 1)?.content).toBe('old-1'); // history kept
  });

  it('a single live entry never drops persisted history', () => {
    const merged = mergeBoardMessages([board(1, 'a'), board(2, 'b')], [board(9, 'c')]);
    expect(merged).toHaveLength(3);
  });
});

const run = (id: number, role: string, over: Partial<PersistedAgentRun> = {}): PersistedAgentRun => ({
  id,
  role,
  status: 'completed',
  provider: 'anthropic',
  model: 'opus',
  project_ids_json: '[]',
  coder_session_id: 100 + id,
  ...over,
});

const live = (id: number, over: Partial<AgentStreamState> = {}): AgentStreamState => ({
  role: 'backend',
  agentRunId: id,
  textChunks: [],
  toolCalls: [],
  status: 'running',
  ...over,
});

describe('mergeSubordinates', () => {
  it('shows persisted-only agents (excludes master) with their coder_session_id', () => {
    const merged = mergeSubordinates([run(1, 'master'), run(2, 'frontend'), run(3, 'backend')], new Map());
    expect(merged.map((a) => a.agentRunId)).toEqual([2, 3]);
    expect(merged.find((a) => a.agentRunId === 2)?.coderSessionId).toBe(102);
  });

  it('overlays live state by agentRunId (live wins) and dedups', () => {
    const merged = mergeSubordinates(
      [run(2, 'frontend')],
      new Map([[2, live(2, { status: 'running', textChunks: ['x'] })]]),
    );
    expect(merged).toHaveLength(1);
    expect(merged[0].status).toBe('running');
    expect(merged[0].textChunks).toEqual(['x']);
  });

  it('preserves persisted coderSessionId when the live seed lacks it', () => {
    const merged = mergeSubordinates([run(2, 'frontend', { coder_session_id: 555 })], new Map([[2, live(2)]]));
    expect(merged[0].coderSessionId).toBe(555);
  });

  it('includes live-only agents not yet persisted', () => {
    const merged = mergeSubordinates([], new Map([[9, live(9, { coderSessionId: 909 })]]));
    expect(merged.map((a) => a.agentRunId)).toEqual([9]);
    expect(merged[0].coderSessionId).toBe(909);
  });
});
