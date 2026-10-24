import type { AuthContext } from '@mcp/services/auth/domain/auth-context.js';
import type { ToolContext } from './context.js';
import { agentRunBaseUrl as baseUrl, jsonRequest } from './agent-run-http.js';
import { McpAgentRunReader, runFromSession, finalAssistantText, type McpAgentRun, type McpAgentRunStatus } from './agent-run-reader.js';

import { AgentStreamInterruptedError, readMcpAgentTerminal } from './agent-run-stream.js';
import {
  buildMcpAgentSessionCreatePayload,
  type StartMcpAgentRunInput,
} from './agent-run-contract.js';



export class McpAgentRunManager extends McpAgentRunReader<ToolContext> {
  private readonly controllers = new Map<string, AbortController>();
  private readonly cancelled = new Set<string>();
  private readonly admissions = new Map<string, Promise<McpAgentRun>>();
  private readonly busIdentities = new Map<string, string>();

  constructor(ctx: ToolContext, request: typeof jsonRequest = jsonRequest) { super(ctx, request); }

  async start(
    input: StartMcpAgentRunInput,
    authCtx?: AuthContext,
  ): Promise<McpAgentRun> {
    // The HTTP calls below yield. Serialize admission for the same quota so
    // two starts cannot both observe the last free slot before either reserves it.
    const key = JSON.stringify([authCtx?.principal ?? 'local-dev', authCtx?.policy?.id ?? null]);
    const previous = this.admissions.get(key);
    const admission = (previous ? previous.catch(() => undefined) : Promise.resolve())
      .then(() => this.startAdmitted(input, authCtx));
    this.admissions.set(key, admission);
    try { return await admission; }
    finally { if (this.admissions.get(key) === admission) this.admissions.delete(key); }
  }

  private async startAdmitted(input: StartMcpAgentRunInput, authCtx?: AuthContext): Promise<McpAgentRun> {
    const principal = authCtx?.principal ?? 'local-dev';
    const profile = authCtx?.policy ?? null;
    if (
      profile?.agentAllowlist.length
      && !profile.agentAllowlist.includes(input.agentId)
    ) {
      throw new Error(
        `Agent '${input.agentId}' is outside connection profile '${profile.name}'`,
      );
    }
    const activeQuery = new URLSearchParams({ principal, profile_id: profile?.id ?? '', mode: 'active' });
    const active = await this.request<{ active_ids: string[] }>(this.ctx, `/api/coder/mcp-runs?${activeQuery}`);
    if (!Array.isArray(active.active_ids) || active.active_ids.some(id => typeof id !== 'string' || !id)) {
      throw new Error('Active agent-run ownership response is invalid');
    }
    const activeIds = new Set(active.active_ids);
    for (const run of this.live.values()) {
      if (run.principal === principal && run.profileId === (profile?.id ?? null)
        && (run.status === 'starting' || run.status === 'running')) activeIds.add(run.id);
    }
    if (activeIds.size >= (profile?.maxConcurrentRuns ?? 2)) {
      throw new Error(
        `Concurrent agent-run limit reached (${profile?.maxConcurrentRuns ?? 2})`,
      );
    }

    const project = this.ctx.db.listProjects().find(
      (candidate) =>
        candidate.name === input.projectName
        || String(candidate.id) === input.projectName,
    );
    if (!project) throw new Error(`Unknown project: ${input.projectName}`);

    const session = await this.request<unknown>(
      this.ctx,
      '/api/coder/sessions',
      {
        method: 'POST',
        body: JSON.stringify(
          buildMcpAgentSessionCreatePayload(input, project.id, {
            principal,
            profileId: profile?.id ?? null,
          }),
        ),
      },
    );
    const run = runFromSession(session);
    if (!run) {
      throw new Error('Filesystem session response omitted MCP run metadata');
    }
    run.status = 'running';
    run.updatedAt = Date.now();
    this.live.set(run.id, run);
    void this.execute(
      run.id,
      input.task,
      profile?.maxRuntimeMs ?? 1_800_000,
    );
    return { ...run };
  }

  async cancel(runId: string, authCtx?: AuthContext): Promise<McpAgentRun> {
    const run = await this.get(runId, authCtx);
    if (!['starting', 'running'].includes(run.status)) return run;
    const expectedBus = this.busIdentities.get(runId);
    this.cancelled.add(runId);
    this.controllers.get(runId)?.abort();
    let cancellationError: string | null = null;
    let status: McpAgentRunStatus = 'interrupted';
    try {
      await this.request(this.ctx, `/api/coder/sessions/${run.sessionId}/abort`, {
        method: 'POST', body: '{}', signal: AbortSignal.timeout(10_000),
      });
    } catch (error) {
      cancellationError = `Cancellation acknowledgement was not confirmed: ${error instanceof Error ? error.message : String(error)}`;
    }
    if (!cancellationError) {
      try {
        const signal = AbortSignal.timeout(30_000);
        const response = await fetch(`${baseUrl(this.ctx)}/api/coder/sessions/${run.sessionId}/attach`, {
          signal, headers: { accept: 'text/event-stream' },
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const terminal = await readMcpAgentTerminal(response, signal, { expected: expectedBus });
        status = terminal.classification;
        if (status === 'failed') cancellationError = terminal.message ?? terminal.error ?? terminal.reason;
      } catch (error) {
        cancellationError = `Cancellation outcome was not confirmed: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
    const updated = {
      ...run,
      status,
      error: cancellationError,
      updatedAt: Date.now(),
    };
    this.live.set(runId, updated);
    return { ...updated };
  }

  private async execute(
    runId: string,
    task: string,
    maxRuntimeMs: number,
  ): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), maxRuntimeMs);
    this.controllers.set(runId, controller);
    try {
      const response = await fetch(
        `${baseUrl(this.ctx)}/api/coder/sessions/${runId}/messages`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'text/event-stream',
          },
          body: JSON.stringify({ content: task }),
          signal: controller.signal,
        },
      );
      if (!response.ok) {
        throw new Error(
          (await response.text())
          || `Agent stream failed: HTTP ${response.status}`,
        );
      }
      const terminal = await readMcpAgentTerminal(response, controller.signal, {
        observed: busId => this.busIdentities.set(runId, busId),
      });
      if (this.cancelled.has(runId)) return;
      const detail = await this.request<unknown>(
        this.ctx,
        `/api/coder/sessions/${runId}?tail=60&full=1`,
        { signal: controller.signal },
      ).catch(() => null);
      if (this.cancelled.has(runId)) return;
      const persisted = runFromSession(detail);
      const current = this.live.get(runId);
      if (current) {
        this.live.set(runId, {
          ...(persisted ?? current),
          status: terminal.classification,
          finalText:
            finalAssistantText(detail)
            ?? (terminal.classification === 'completed' ? 'Run completed; open the linked CodeStudio session for the full transcript.' : null),
          error: terminal.classification === 'failed' ? terminal.message ?? terminal.error ?? terminal.reason : null,
          updatedAt: Date.now(),
        });
      }
    } catch (error) {
      if (this.cancelled.has(runId)) return;
      const timedOut = controller.signal.aborted;
      const current = this.live.get(runId);
      if (current) {
        this.live.set(runId, {
          ...current,
          status: timedOut || error instanceof AgentStreamInterruptedError ? 'interrupted' : 'failed',
          error: timedOut
            ? `Agent run exceeded its ${maxRuntimeMs} ms runtime limit`
            : error instanceof Error
              ? error.message
              : String(error),
          updatedAt: Date.now(),
        });
      }
      if (timedOut) {
        await this.request(this.ctx, `/api/coder/sessions/${runId}/abort`, {
          method: 'POST',
          body: '{}',
        }).catch(() => undefined);
      }
    } finally {
      clearTimeout(timeout);
      this.controllers.delete(runId);
      this.busIdentities.delete(runId);
      this.cancelled.delete(runId);
    }
  }
}

const managers = new Map<string, McpAgentRunManager>();

export function getMcpAgentRunManager(ctx: ToolContext): McpAgentRunManager {
  let manager = managers.get(ctx.config.dbPath);
  if (!manager) {
    manager = new McpAgentRunManager(ctx);
    managers.set(ctx.config.dbPath, manager);
  }
  return manager;
}
