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

const board = (seq: number, content: string): BoardMessage => ({
  id: `b0000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
  seq,
  author_role: 'system',
  agent_run_id: null,
  kind: 'message',
  content,
  mentions: [],
  created_at: `2026-01-01T00:00:0${seq}Z`,
});

describe('mergeBoardMessages', () => {
  it('keeps persisted history AND appends live, deduped by id (live wins)', () => {
    const merged = mergeBoardMessages(
      [board(1, 'old-1'), board(2, 'old-2')],
      [board(2, 'live-2'), board(3, 'live-3')],
    );
    expect(merged.map((m) => m.seq).sort((a, b) => a - b)).toEqual([1, 2, 3]);
    expect(merged.find((m) => m.seq === 2)?.content).toBe('live-2'); // live wins
    expect(merged.find((m) => m.seq === 1)?.content).toBe('old-1'); // history kept
  });

  it('a single live entry never drops persisted history', () => {
    const merged = mergeBoardMessages([board(1, 'a'), board(2, 'b')], [board(9, 'c')]);
    expect(merged).toHaveLength(3);
  });
});

const uuid = (n: number): string =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const run = (n: number, role: string, over: Partial<PersistedAgentRun> = {}): PersistedAgentRun => ({
  id: uuid(n),
  role,
  status: 'completed',
  provider: 'anthropic',
  model: 'opus',
  project_ids_json: '[]',
  coder_session_id: uuid(100 + n),
  ...over,
});

const live = (n: number, over: Partial<AgentStreamState> = {}): AgentStreamState => ({
  role: 'backend',
  agentRunId: uuid(n),
  toolCalls: [],
  status: 'running',
  ...over,
});

describe('mergeSubordinates', () => {
  it('shows persisted-only agents (excludes master) with their coder_session_id', () => {
    const merged = mergeSubordinates([run(1, 'master'), run(2, 'frontend'), run(3, 'backend')], new Map());
    expect(merged.map((a) => a.agentRunId)).toEqual([uuid(2), uuid(3)]);
    expect(merged.find((a) => a.agentRunId === uuid(2))?.coderSessionId).toBe(uuid(102));
  });

  it('overlays live state by agentRunId (live wins) and dedups', () => {
    const merged = mergeSubordinates(
      [run(2, 'frontend')],
      new Map([[uuid(2), live(2, { status: 'running', statusMessage: 'live progress' })]]),
    );
    expect(merged).toHaveLength(1);
    expect(merged[0].status).toBe('running');
    expect(merged[0].statusMessage).toBe('live progress');
  });

  it('preserves persisted coderSessionId when the live seed lacks it', () => {
    const persistedCoderSessionId = uuid(555);
    const merged = mergeSubordinates(
      [run(2, 'frontend', { coder_session_id: persistedCoderSessionId })],
      new Map([[uuid(2), live(2)]]),
    );
    expect(merged[0].coderSessionId).toBe(persistedCoderSessionId);
  });

  it('includes live-only agents not yet persisted', () => {
    const coderSessionId = uuid(909);
    const merged = mergeSubordinates(
      [],
      new Map([[uuid(9), live(9, { coderSessionId })]]),
    );
    expect(merged.map((a) => a.agentRunId)).toEqual([uuid(9)]);
    expect(merged[0].coderSessionId).toBe(coderSessionId);
  });
});
