import type { BoardEntry } from '@mcp/company/types.js';
import type { BoardBridge } from '../services/BoardBridge.js';
import type { SessionContext } from '../services/SessionContext.js';

export interface ReadBoardOptions {
  sinceId?: number;
  limit?: number;
  mentionsRole?: string;
  /**
   * When provided WITHOUT `sinceId`, the orchestrator looks up the agent's
   * persisted watermark and uses it as the lower bound. Lets subordinates
   * do `read_board({from_watermark: true})` without remembering offsets
   * across turns.
   */
  fromWatermarkAgentRunId?: number;
  /**
   * After reading, advance the agent's watermark to the MAX board id
   * returned. Opt-in — non-mutating reads (e.g. master's enrich path)
   * leave this off so the watermark only moves when the agent acknowledges
   * consumption.
   */
  markSeenForAgentRunId?: number;
}

export function readBoardWithWatermarks(
  board: BoardBridge,
  ctx: SessionContext,
  companySessionId: number,
  opts?: ReadBoardOptions,
): BoardEntry[] {
  let sinceId = opts?.sinceId;
  if (sinceId === undefined && opts?.fromWatermarkAgentRunId !== undefined) {
    sinceId = ctx.companyStore.getAgentBoardWatermark(
      companySessionId,
      opts.fromWatermarkAgentRunId,
    );
  }
  const entries = board.read({
    sinceId,
    limit: opts?.limit,
    mentionsRole: opts?.mentionsRole,
  });
  if (opts?.markSeenForAgentRunId !== undefined && entries.length > 0) {
    const maxId = entries.reduce((m, e) => (e.id > m ? e.id : m), 0);
    if (maxId > 0) {
      ctx.companyStore.setAgentBoardWatermark(
        companySessionId,
        opts.markSeenForAgentRunId,
        maxId,
      );
    }
  }
  return entries;
}
