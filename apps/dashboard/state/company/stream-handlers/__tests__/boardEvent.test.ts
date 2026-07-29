import { describe, expect, it } from 'vitest';
import { INITIAL_STREAM_STATE, type BoardMessage, type StreamState } from '../../types.js';
import { applyBoardEntry } from '../boardEvent.js';

const IDS = {
  first: '10000000-0000-4000-8000-000000000000',
  tiedEarlier: '20000000-0000-4000-8000-000000000000',
  tiedLater: '30000000-0000-4000-8000-000000000000',
} as const;

function state(): StreamState {
  return { ...INITIAL_STREAM_STATE, boardMessages: [] };
}

function message(id: string, seq: number, createdAt: string): BoardMessage {
  return {
    id,
    seq,
    author_role: 'master',
    agent_run_id: null,
    kind: 'status',
    content: id,
    mentions: [],
    created_at: createdAt,
  };
}

describe('boardEvent UUID identity', () => {
  it('orders by sequence and uses timestamp/UUID only as stable tie-breakers', () => {
    const tiedLater = message(IDS.tiedLater, 2, '2026-07-27T10:02:00.000Z');
    const first = message(IDS.first, 1, '2026-07-27T10:03:00.000Z');
    const tiedEarlier = message(IDS.tiedEarlier, 2, '2026-07-27T10:02:00.000Z');

    let next = applyBoardEntry(state(), tiedLater);
    next = applyBoardEntry(next, first);
    next = applyBoardEntry(next, tiedEarlier);

    expect(next.boardMessages.map((entry) => entry.id)).toEqual([
      IDS.first,
      IDS.tiedEarlier,
      IDS.tiedLater,
    ]);
  });

  it('deduplicates replayed messages by UUID', () => {
    const entry = message(IDS.first, 1, '2026-07-27T10:00:00.000Z');
    const once = applyBoardEntry(state(), entry);

    expect(applyBoardEntry(once, entry)).toBe(once);
  });
});
