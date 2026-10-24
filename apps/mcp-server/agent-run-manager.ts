import type { AuthContext } from '@mcp/services/auth/domain/auth-context.js';
import type { ToolContext } from './context.js';
import { AgentRunHttpError, agentReadSignal, agentRunPath, agentRunBaseUrl as baseUrl, jsonRequest } from './agent-run-http.js';
import { AgentStreamInterruptedError, readMcpAgentTerminal } from './agent-run-stream.js';
import {
  buildMcpAgentSessionCreatePayload,
  type StartMcpAgentRunInput,
} from './agent-run-contract.js';

export type { StartMcpAgentRunInput } from './agent-run-contract.js';

export type McpAgentRunStatus =
  | 'starting'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted';

export interface McpAgentRun {
  id: string;
  principal: string;
  profileId: string | null;
  sessionId: string;
  projectId: number;
  agentId: string;
  status: McpAgentRunStatus;
  taskPreview: string;
  finalText: string | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

interface SessionView {
  id?: unknown;
  project_id?: unknown;
  agent?: unknown;
  status?: unknown;
  created_at?: unknown;
  updated_at?: unknown;
  metadata?: unknown;
  messages?: unknown;
}

interface McpRunMetadata {
  schema_version: 1;
  principal: string;
  profile_id: string | null;
  agent_id: string;
  task_preview: string;
}

function record(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function sessionView(payload: unknown): SessionView | null {
  const root = record(payload);
  if (!root) return null;
  const nested = record(root.session);
  return (nested ?? root) as SessionView;
}

function runMetadata(view: SessionView): McpRunMetadata | null {
  const metadata = record(view.metadata);
  const value = record(metadata?.mcp_agent_run);
  if (
    value?.schema_version !== 1
    || typeof value.principal !== 'string'
    || (value.profile_id !== null && typeof value.profile_id !== 'string')
    || typeof value.agent_id !== 'string'
    || typeof value.task_preview !== 'string'
  ) {
    return null;
  }
  return value as unknown as McpRunMetadata;
}

function finalAssistantText(payload: unknown): string | null {
  const root = record(payload);
  if (!root) return null;
  const nested = record(root.session);
  const candidates = [root.messages, nested?.messages];
  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) continue;
    for (let index = candidate.length - 1; index >= 0; index -= 1) {
      const message = record(candidate[index]);
      if (message?.role !== 'assistant') continue;
      if (typeof message.content === 'string' && message.content.trim()) {
        return message.content;
      }
      if (typeof message.text === 'string' && message.text.trim()) {
        return message.text;
      }
      if (Array.isArray(message.content)) {
        const text = message.content
          .map(record)
          .filter((block) => block?.type === 'text' && typeof block.text === 'string')
          .map((block) => block!.text as string)
          .join('\n')
          .trim();
        if (text) return text;
      }
    }
  }
  return null;
}

function timestamp(value: unknown): number {
  const parsed = typeof value === 'string' ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function projectedStatus(
  status: unknown,
  finalText: string | null,
): McpAgentRunStatus {
  if (status === 'running' || status === 'in_progress' || status === 'working') {
    return 'running';
  }
  if (status === 'error' || status === 'failed') return 'failed';
  if (status === 'interrupted') return 'interrupted';
  if (status === 'cancelled' || status === 'aborted') return 'cancelled';
  return finalText ? 'completed' : 'interrupted';
}

function runFromSession(payload: unknown): McpAgentRun | null {
  const view = sessionView(payload);
  if (!view || typeof view.id !== 'string') return null;
  const metadata = runMetadata(view);
  if (!metadata || !Number.isSafeInteger(view.project_id)) return null;
  const finalText = finalAssistantText(payload);
  return {
    id: view.id,
    principal: metadata.principal,
    profileId: metadata.profile_id,
    sessionId: view.id,
    projectId: view.project_id as number,
    agentId:
      typeof view.agent === 'string' ? view.agent : metadata.agent_id,
    status: projectedStatus(view.status, finalText),
    taskPreview: metadata.task_preview,
    finalText,
    error: view.status === 'error' || view.status === 'failed' ? 'Agent session failed' : null,
    createdAt: timestamp(view.created_at),
    updatedAt: timestamp(view.updated_at),
  };
}

export class McpAgentRunManager {
  private readonly controllers = new Map<string, AbortController>();
  private readonly cancelled = new Set<string>();
  private readonly live = new Map<string, McpAgentRun>();
  private readonly admissions = new Map<string, Promise<McpAgentRun>>();
  private readonly busIdentities = new Map<string, string>();

  private readonly ctx: ToolContext;
  constructor(ctx: ToolContext, private readonly request: typeof jsonRequest = jsonRequest) {
    const { signal: _requestSignal, ...shared } = ctx;
    this.ctx = shared;
  }

  async catalog(signal?: AbortSignal): Promise<unknown> {
    const owner = new AbortController();
    const requestSignal = agentReadSignal(signal ? AbortSignal.any([signal, owner.signal]) : owner.signal);
    try {
      const [agents, providers] = await Promise.all([
        this.request<unknown>(this.ctx, '/api/coder/agents', { signal: requestSignal }),
        this.request<unknown>(this.ctx, '/api/coder/providers', { signal: requestSignal }),
      ]);
      return { agents, providers };
    } finally { owner.abort(); }
  }

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

  async get(runId: string, authCtx?: AuthContext, signal?: AbortSignal): Promise<McpAgentRun> {
    signal?.throwIfAborted();
    const path = agentRunPath(runId);
    const principal = authCtx?.principal ?? 'local-dev';
    let run = this.live.get(runId) ?? null;
    if (!run) {
      const detail = await this.request<unknown>(
        this.ctx,
        `${path}?tail=60&full=1`, { signal },
      ).catch(error => {
        signal?.throwIfAborted();
        if (error instanceof AgentRunHttpError && error.status === 404) return null;
        throw error;
      });
      run = runFromSession(detail);
    }
    if (!run) throw new Error(`Unknown agent run: ${runId}`);
    if (run.id !== runId) throw new Error('Agent run response has a divergent identity');
    if (run.principal !== principal) {
      throw new Error('Agent run belongs to another principal');
    }
    const policy = authCtx?.policy;
    if (policy && (run.profileId !== (policy.id ?? null)
      || (policy.projectIds?.length && !policy.projectIds.includes(run.projectId))
      || (policy.agentAllowlist?.length && !policy.agentAllowlist.includes(run.agentId)))) {
      throw new Error('Agent run is outside this connection profile');
    }
    signal?.throwIfAborted();
    return { ...run };
  }

  async list(authCtx?: AuthContext, limit = 50, signal?: AbortSignal): Promise<McpAgentRun[]> {
    const requestSignal = agentReadSignal(signal);
    requestSignal.throwIfAborted();
    const principal = authCtx?.principal ?? 'local-dev';
    const pageLimit = Math.max(1, Math.min(200, Number.isFinite(limit) ? Math.floor(limit) : 50));
    const query = new URLSearchParams({ principal, limit: String(pageLimit) });
    const page = await this.request<{ items: unknown[] }>(this.ctx, `/api/coder/mcp-runs?${query}`, { signal: requestSignal });
    if (!Array.isArray(page.items) || page.items.length > pageLimit) throw new Error('Agent run page exceeds its bound');
    const discovered = page.items
      .map(runFromSession)
      .filter((run): run is McpAgentRun => run?.principal === principal);
    const merged = new Map(discovered.map((run) => [run.id, run]));
    for (const run of this.live.values()) {
      if (run.principal === principal) merged.set(run.id, { ...run });
    }
    const policy = authCtx?.policy;
    const selected = [...merged.values()].filter(run => !policy || (run.profileId === (policy.id ?? null)
      && (!policy.projectIds?.length || policy.projectIds.includes(run.projectId))
      && (!policy.agentAllowlist?.length || policy.agentAllowlist.includes(run.agentId))))
      .sort((left, right) => right.createdAt - left.createdAt)
      .slice(0, pageLimit);
    // List rows contain session metadata, not the durable runtime outcome.
    // Resolve only this page, at bounded concurrency, after process restart.
    const runs: McpAgentRun[] = [];
    for (let offset = 0; offset < selected.length; offset += 4) {
      requestSignal.throwIfAborted();
      runs.push(...await Promise.all(selected.slice(offset, offset + 4).map(run => this.get(run.id, authCtx, requestSignal))));
    }
    return runs;
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
