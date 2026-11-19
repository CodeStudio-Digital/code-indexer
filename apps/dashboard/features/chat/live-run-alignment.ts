import type { StreamBlock } from '../../hooks/agent-stream/types.js';

/**
 * Live ⇄ persisted alignment primitives.
 *
 * The live buffer and the durable transcript describe the SAME assistant run,
 * but they do not agree on where one block ends and the next begins:
 *
 *  - the backend flushes TEXT at every tool boundary (`consumeStream`) but
 *    flushes THINKING only once, at the end of the provider round — so one
 *    persisted message holds a single concatenated reasoning block;
 *  - the live coalescer instead opens a NEW thinking block whenever a tool
 *    lands in between (`handlers.ts`).
 *
 * For a round shaped `thinkA → tool → thinkB` the durable side reads
 * `"thinkAthinkB"` while the live side joins its two blocks as
 * `"thinkA\nthinkB"`. Comparing those raw strings says "different run", the
 * arbitration falls back to rendering BOTH copies, and the live one loses its
 * tool blocks to id dedup — the reported "repeated text and thinking with no
 * tool calls".
 *
 * Block segmentation is a transport artifact, so every live⇄persisted
 * comparison happens on whitespace-stripped text and stops caring about it.
 *
 * Kept out of `utils.ts` (already 1k+ LOC) and dependency-free: the two
 * identity helpers arrive as callbacks so this module never imports back into
 * `utils.ts`.
 */

/** Collapse away every boundary the two sides can legitimately disagree about. */
export function normalizeRunText(value: string): string {
  return value.replace(/\s+/g, '');
}

/**
 * `live` reproduces the whole of `persisted`. `anywhere` relaxes the anchor to
 * a substring match for a window that begins mid-turn, where the live buffer
 * may hold cycles older than the loaded page.
 */
export function normalizedCovers(live: string, persisted: string, anywhere: boolean): boolean {
  if (!persisted) return true;
  return anywhere ? live.includes(persisted) : live.startsWith(persisted);
}

/** The reverse direction: `persisted` already contains all of `live`. */
export function normalizedDuplicated(persisted: string, live: string, anywhere: boolean): boolean {
  if (!live) return false;
  return anywhere ? persisted.endsWith(live) : persisted === live;
}

export interface CoverageContext {
  persistedTextNormalized: string;
  persistedThinkingNormalized: string;
  persistedIds: Set<string>;
  persistedSignatures: Set<string>;
  blockId: (block: StreamBlock) => string | undefined;
  blockSignature: (block: StreamBlock) => string | undefined;
  /**
   * The live buffer is a suffix of the persisted run, so its first text/thinking
   * chunk starts somewhere inside history rather than at offset zero. Only the
   * anchor moves — the walk stays contiguous from there.
   */
  anchorAnywhere?: boolean;
}

/**
 * Live-only visualizations. They carry no durable identity, so they can neither
 * confirm nor break the alignment — the walk passes straight through them
 * instead of treating them as a mismatch.
 */
const TRANSPARENT_BLOCKS = new Set(['activity', 'agents', 'task_run', 'workflow', 'notice', 'usage']);

/**
 * Index of the last live block already rendered by the persisted run, or -1.
 *
 * An ORDERED CURSOR, not a set membership test: text/thinking must continue the
 * durable run at the current offset. A plain "does history contain this string"
 * check would swallow a genuinely new block that merely repeats an earlier
 * phrase ("Pronto.", "Done."). The first block that does not line up ends the
 * prefix — a covered prefix has to be contiguous to be safe to drop.
 */
export function persistedCoveragePrefixEnd(blocks: StreamBlock[], ctx: CoverageContext): number {
  let prefixEnd = -1;
  let textCursor = 0;
  let thinkingCursor = 0;
  let textAnchored = false;
  let thinkingAnchored = false;

  for (let index = 0; index < blocks.length; index++) {
    const block = blocks[index];

    if (block.type === 'text' || block.type === 'thinking') {
      const chunk = normalizeRunText(block.text);
      // An empty block proves nothing and consumes nothing.
      if (!chunk) continue;
      const isText = block.type === 'text';
      const durable = isText ? ctx.persistedTextNormalized : ctx.persistedThinkingNormalized;
      const anchored = isText ? textAnchored : thinkingAnchored;
      let cursor = isText ? textCursor : thinkingCursor;
      if (!durable.startsWith(chunk, cursor)) {
        // A suffix buffer only gets ONE chance to find where it resumes; after
        // that the walk is ordered again, so a repeated phrase still cannot
        // swallow genuinely new content.
        if (!ctx.anchorAnywhere || anchored) break;
        const anchor = durable.lastIndexOf(chunk);
        if (anchor < cursor) break;
        cursor = anchor;
      }
      if (isText) {
        textCursor = cursor + chunk.length;
        textAnchored = true;
      } else {
        thinkingCursor = cursor + chunk.length;
        thinkingAnchored = true;
      }
      prefixEnd = index;
      continue;
    }

    if (TRANSPARENT_BLOCKS.has(block.type)) continue;

    const id = ctx.blockId(block);
    if (id && ctx.persistedIds.has(id)) {
      prefixEnd = index;
      continue;
    }
    const signature = ctx.blockSignature(block);
    if (signature && ctx.persistedSignatures.has(signature)) {
      prefixEnd = index;
      continue;
    }
    // An identity history has never seen is a hard chronological boundary:
    // everything from here on is genuinely new.
    break;
  }

  return prefixEnd;
}
