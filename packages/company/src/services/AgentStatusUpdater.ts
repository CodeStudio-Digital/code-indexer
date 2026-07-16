/**
 * AgentStatusUpdater — centralises all writes to `company_agent_runs.status`
 * and the matching `agent_status` meta-bus event. Services inject this
 * narrow port so they don't need the full CompanyStore surface just to
 * update a single row.
 */

import type { SessionContext } from '@mcp/company/services/SessionContext.js';
import type { IAgentStatusUpdater, IMetaBusPublisher } from '@mcp/company/services/ports.js';
import type { AgentRunStatus } from '@mcp/company/types.js';

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
   * Write the status AND publish an `agent_status` event (no board post).
   * `opts.coderSessionId` rides along so the dashboard can open the agent's
   * transcript the moment it spawns. Used at subordinate spawn, where a
   * separate "Spawned @role" board line is already posted.
   */
  publishStatus(
    agentRunId: number,
    role: string,
    status: AgentRunStatus,
    opts?: { message?: string; coderSessionId?: number },
  ): void {
    this.setStatus(agentRunId, status, opts?.message);
    const run = this.ctx.runtimeKind === 'app_studio'
      ? this.ctx.companyStore.getAgentRun(agentRunId)
      : null;
    const runtime = run && run.company_session_id === this.ctx.companySessionId ? {
      configuredProvider: run.configured_provider,
      configuredModel: run.configured_model,
      effectiveProvider: run.provider,
      effectiveModel: run.model,
      dispatchSource: run.dispatch_source,
      fallbackReason: run.fallback_reason,
    } : {};
    this.bus.publish('agent_status', {
      agentRunId,
      role,
      status,
      message: opts?.message ?? '',
      coderSessionId: opts?.coderSessionId,
      ...runtime,
    });
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
    this.publishStatus(agentRunId, role, status, { message });
    boardPoster.post(role, agentRunId, 'message',
      `Status: **${status}**${message ? ` — ${message}` : ''}`);
  }
}
