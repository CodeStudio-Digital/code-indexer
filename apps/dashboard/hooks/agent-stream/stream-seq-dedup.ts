/**
 * Replay dedup for the chat transcript.
 *
 * `text` / `thinking` handlers GROW the block buffer by concatenation
 * (`prior.text += t`, handlers.ts). A cursorless attach replays the whole live
 * tail since the last `message_complete` (`buildAttachReplay`), and the server
 * also full-replays whenever it cannot honour our cursor — so re-delivering one
 * of those deltas appends its content a SECOND time inside the same card.
 *
 * Every other event is idempotent, keyed by tool_use id / opId / lifecycle
 * position, and a replay must stay free to REBUILD that structure — that is the
 * whole point of the attach replay. So the filter covers only the accumulative
 * deltas and lets everything else through.
 *
 * The same (busId, seq) pairing already guards the worker-log panel; see
 * `worker-log-store.ts`. Here the high-water mark is `openStream`'s own
 * `lastSeenSeq`, which is never ahead of the block buffer: `initialBlocks` is
 * inherited ONLY together with its paired cursor (`useAgentStream.reattach`)
 * and a bus change resets it to -1. Skipping can therefore never hide content
 * that is not already on screen.
 */

/**
 * `stream_rollback` belongs here too, and for the same reason read backwards:
 * it RETRACTS a failed attempt's deltas by character count, so applying it a
 * second time would eat content the first application already removed. It has
 * to be skipped exactly when the deltas it cancels are skipped — the two share
 * one idempotency class, and separating them would desynchronize the buffer.
 */
const SEQ_GUARDED_EVENTS = new Set(['text', 'thinking', 'stream_rollback']);

/** True when this event's effect is already folded into the block buffer. */
export function isAlreadyAppliedDelta(
  event: string,
  id: number | undefined,
  highWaterMark: number,
): boolean {
  if (id === undefined || id > highWaterMark) return false;
  return SEQ_GUARDED_EVENTS.has(event);
}
