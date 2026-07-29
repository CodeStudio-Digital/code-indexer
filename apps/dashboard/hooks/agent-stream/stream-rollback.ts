import type { StreamBlock } from './types.js';

/**
 * Retract the trailing output of a provider attempt that died mid-stream.
 *
 * The runner emits `stream_rollback` with how many characters that attempt
 * streamed. Nothing it produced was persisted (`assistantContent` is only built
 * on success) and the retry re-reasons from the same transcript, so without the
 * retraction the discarded attempt stays on screen with a near-identical
 * replacement rendered right underneath it.
 *
 * Character counts rather than block indices on purpose: the live buffer
 * reshapes itself constantly (activity blocks are swept in and out by the
 * text/thinking handlers), so any index captured earlier would already be
 * stale. Lengths stay true whatever happened to the array in between.
 */
export function rollbackStreamedChars(
  blocks: StreamBlock[],
  type: 'text' | 'thinking',
  chars: number,
): boolean {
  if (!Number.isFinite(chars) || chars <= 0) return false;
  let remaining = chars;
  let changed = false;

  for (let index = blocks.length - 1; index >= 0 && remaining > 0; index--) {
    const block = blocks[index];
    // A dispatched tool is a hard floor: everything above it belongs to an
    // attempt that already completed and persisted. A miscounted payload must
    // never be able to eat into durable content.
    if (block.type === 'tool') break;
    if (block.type !== type) continue;

    if (block.text.length <= remaining) {
      remaining -= block.text.length;
      blocks.splice(index, 1);
    } else {
      block.text = block.text.slice(0, block.text.length - remaining);
      remaining = 0;
    }
    changed = true;
  }

  return changed;
}
