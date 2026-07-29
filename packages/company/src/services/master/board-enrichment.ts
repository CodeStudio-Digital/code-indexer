/**
 * Append a tail of recent board entries to a notification message
 * destined for the master agent. Lets the master see "what happened
 * since I last looked" without spending tokens on `read_board` calls.
 *
 * Side effects (intentional):
 *   - Advances the master's board watermark to the last-seen entry sequence,
 *     so subsequent enrichments don't duplicate context.
 *
 * Errors are swallowed — a board read failure must never block a
 * subordinate notification from reaching the master.
 */
import type { SessionContext } from '@mcp/company/services/SessionContext.js';
import type { IBoardPoster } from '@mcp/company/services/ports.js';

export interface BoardEnrichmentDeps {
  ctx: SessionContext;
  /** Subset of `IBoardPoster` actually consumed here. */
  board: Pick<IBoardPoster, 'lastMasterSeenSeq' | 'advanceMasterWatermark'>;
}

/**
 * Read up to 30 board entries since the master's watermark, format
 * them as a `[@role] (kind) content` block, and append to `message`.
 * Truncates entries longer than 600 chars. Advances the watermark to
 * the latest entry sequence read.
 *
 * Returns the original message unchanged when:
 *   - The board has no new entries.
 *   - `readBoard` throws (logged silently to keep the notify path live).
 */
export function enrichMessageWithBoard(deps: BoardEnrichmentDeps, message: string): string {
  try {
    const recent = deps.ctx.companyFiles.listBoardEntriesSync({
      sinceSeq: deps.board.lastMasterSeenSeq,
      limit: 30,
    });
    if (recent.length === 0) return message;
    const summary = recent
      .map(
        (e) =>
          `  [@${e.author_role}] (${e.kind}) ${e.content.length > 600 ? e.content.slice(0, 600) + '...' : e.content}`,
      )
      .join('\n');
    const enriched =
      message +
      `\n\n--- Board updates since your last activity (since_seq=${deps.board.lastMasterSeenSeq}) ---\n` +
      summary;
    deps.board.advanceMasterWatermark(recent[recent.length - 1].seq);
    return enriched;
  } catch {
    return message;
  }
}
