/**
 * Reducer for `board_entry` SSE events.
 *
 * The board is a per-session message log. Entries are appended in
 * arrival order; SSE replay is idempotent because we dedup by `id`.
 */
import type { BoardMessage, StreamState } from '../types.js';

export function applyBoardEntry(prev: StreamState, entry: BoardMessage): StreamState {
  if (prev.boardMessages.some((m) => m.id === entry.id)) return prev;
  return { ...prev, boardMessages: [...prev.boardMessages, entry] };
}
