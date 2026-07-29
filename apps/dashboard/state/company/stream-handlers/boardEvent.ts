/**
 * Reducer for `board_entry` SSE events.
 *
 * The board is a per-session message log. UUIDs are identity only:
 * canonical order comes from the per-session sequence, then timestamp
 * and UUID as deterministic tie-breakers. SSE replay is idempotent.
 */
import type { BoardMessage, StreamState } from '../types.js';

export function applyBoardEntry(prev: StreamState, entry: BoardMessage): StreamState {
  if (prev.boardMessages.some((m) => m.id === entry.id)) return prev;
  return {
    ...prev,
    boardMessages: [...prev.boardMessages, entry].sort((a, b) =>
      a.seq - b.seq
      || a.created_at.localeCompare(b.created_at)
      || a.id.localeCompare(b.id),
    ),
  };
}
