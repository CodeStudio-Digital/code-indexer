/**
 * AgentStatusUpdater — centralises all writes to file-backed Company agent runs
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

  setStatus(agentRunId: string, status: AgentRunStatus, message?: string): void {
    void this.ctx.companyFiles
      .updateAgentRunStatus(agentRunId, status, message)
      .catch((error) => {
        console.warn(
          `[company s=${this.ctx.companySessionId}] failed to persist agent ${agentRunId} status:`,
          error,
        );
      });
  }

  /**
   * Write the status AND publish an `agent_status` event (no board post).
   * `opts.coderSessionId` rides along so the dashboard can open the agent's
   * transcript the moment it spawns. Used at subordinate spawn, where a
   * separate "Spawned @role" board line is already posted.
   */
  publishStatus(
    agentRunId: string,
    role: string,
    status: AgentRunStatus,
    opts?: { message?: string; coderSessionId?: string },
  ): void {
    this.setStatus(agentRunId, status, opts?.message);
    if (this.ctx.runtimeKind !== 'app_studio') {
      this.publishStatusEvent(agentRunId, role, status, opts);
      return;
    }
    try {
      const run = this.ctx.companyFiles.getAgentRunSync(agentRunId);
      const runtime = run?.company_session_id === this.ctx.companySessionId
        ? {
            configuredProvider: run.configured_provider,
            configuredModel: run.configured_model,
            effectiveProvider: run.provider,
            effectiveModel: run.model,
            dispatchSource: run.dispatch_source,
            fallbackReason: run.fallback_reason,
          }
        : {};
      this.publishStatusEvent(agentRunId, role, status, opts, runtime);
    } catch (error) {
      console.warn(
        `[company s=${this.ctx.companySessionId}] failed to read agent ${agentRunId} runtime provenance:`,
        error,
      );
      this.publishStatusEvent(agentRunId, role, status, opts);
    }
  }

  private publishStatusEvent(
    agentRunId: string,
    role: string,
    status: AgentRunStatus,
    opts?: { message?: string; coderSessionId?: string },
    runtime: Record<string, unknown> = {},
  ): void {
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
    agentRunId: string,
    role: string,
    status: AgentRunStatus,
    message: string,
    boardPoster: { post: (a: string, b: string | null, k: 'message', c: string) => void },
  ): void {
    this.publishStatus(agentRunId, role, status, { message });
    boardPoster.post(role, agentRunId, 'message',
      `Status: **${status}**${message ? ` — ${message}` : ''}`);
  }
}
