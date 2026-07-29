import type { BoardEntry } from '@mcp/company/types.js';
import type { AgentRunId, CompanySessionId } from '@mcp/session-storage';
import type { BoardBridge } from '../services/BoardBridge.js';
import type { SessionContext } from '../services/SessionContext.js';

export interface ReadBoardOptions {
  sinceSeq?: number;
  limit?: number;
  mentionsRole?: string;
  /**
   * When provided WITHOUT `sinceSeq`, the orchestrator looks up the agent's
   * persisted watermark and uses it as the lower bound. Lets subordinates
   * do `read_board({from_watermark: true})` without remembering offsets
   * across turns.
   */
  fromWatermarkAgentRunId?: AgentRunId | string;
  /**
   * After reading, advance the agent's watermark to the MAX board sequence
   * returned. Opt-in — non-mutating reads (e.g. master's enrich path)
   * leave this off so the watermark only moves when the agent acknowledges
   * consumption.
   */
  markSeenForAgentRunId?: AgentRunId | string;
}

export async function readBoardWithWatermarks(
  board: BoardBridge,
  ctx: SessionContext,
  companySessionId: CompanySessionId,
  opts?: ReadBoardOptions,
): Promise<BoardEntry[]> {
  if (companySessionId !== ctx.companySessionId) {
    throw new Error(
      `Board session mismatch: ${companySessionId} != ${ctx.companySessionId}`,
    );
  }
  let sinceSeq = opts?.sinceSeq;
  if (sinceSeq === undefined && opts?.fromWatermarkAgentRunId !== undefined) {
    sinceSeq = ctx.companyFiles.getAgentBoardWatermarkSync(
      opts.fromWatermarkAgentRunId,
    );
  }
  const entries = board.read({
    sinceSeq,
    limit: opts?.limit,
    mentionsRole: opts?.mentionsRole,
  });
  if (opts?.markSeenForAgentRunId !== undefined && entries.length > 0) {
    const maxSeq = entries.reduce((max, entry) => Math.max(max, entry.seq), 0);
    if (maxSeq > 0) {
      await ctx.companyFiles.setAgentBoardWatermark(
        opts.markSeenForAgentRunId,
        maxSeq,
      );
    }
  }
  return entries;
}
