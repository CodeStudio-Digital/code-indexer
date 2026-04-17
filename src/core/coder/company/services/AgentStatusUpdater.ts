/**
 * AgentStatusUpdater — centralises all writes to `company_agent_runs.status`
 * and the matching `agent_status` meta-bus event. Services inject this
 * narrow port so they don't need the full CompanyStore surface just to
 * update a single row.
 */

import type { SessionContext } from './SessionContext.js';
import type { IAgentStatusUpdater, IMetaBusPublisher } from './ports.js';
import type { AgentRunStatus } from '../types.js';

export class AgentStatusUpdater implements IAgentStatusUpdater {
  constructor(
    private readonly ctx: SessionContext,
    private readonly bus: IMetaBusPublisher,
  ) {}

  setStatus(agentRunId: number, status: AgentRunStatus, message?: string): void {
    try {
      this.ctx.companyStore.updateAgentRunStatus(agentRunId, status, message);
    } catch {
      /* DB write failures must never break the stream. */
    }
  }

  /**
   * Extended form that also publishes an `agent_status` event and posts a
   * board message. Used by the public setAgentStatus() API.
   */
  setStatusWithBoard(
    agentRunId: number,
    role: string,
    status: AgentRunStatus,
    message: string,
    boardPoster: { post: (a: string, b: number | null, k: 'message', c: string) => void },
  ): void {
    this.setStatus(agentRunId, status, message);
    this.bus.publish('agent_status', { agentRunId, role, status, message });
    boardPoster.post(role, agentRunId, 'message',
      `Status: **${status}**${message ? ` — ${message}` : ''}`);
  }
}
