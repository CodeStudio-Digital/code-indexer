import type { AuthContext } from '@mcp/services/auth/domain/auth-context.js';
import { AgentRunHttpError, agentReadSignal, agentRunPath, jsonRequest, type AgentRunHttpContext } from './agent-run-http.js';

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

export function finalAssistantText(payload: unknown): string | null {
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

export function runFromSession(payload: unknown): McpAgentRun | null {
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

export class McpAgentRunReader<Context extends AgentRunHttpContext = AgentRunHttpContext> {
  protected readonly live = new Map<string, McpAgentRun>();
  protected readonly ctx: Context;
  constructor(ctx: Context, protected readonly request: typeof jsonRequest = jsonRequest) {
    this.ctx = { ...ctx };
    delete this.ctx.signal;
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

}
