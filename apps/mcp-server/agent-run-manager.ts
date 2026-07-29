import type { AuthContext } from '@mcp/services/auth/domain/auth-context.js';
import type { ToolContext } from './context.js';
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

function baseUrl(ctx: ToolContext): string {
  return `http://127.0.0.1:${ctx.config.dashboard.port}`;
}

async function jsonRequest<T>(
  ctx: ToolContext,
  path: string,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(`${baseUrl(ctx)}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  const text = await response.text();
  let payload: unknown = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = text;
  }
  if (!response.ok) {
    const detail =
      payload && typeof payload === 'object' && 'error' in payload
        ? String((payload as { error: unknown }).error)
        : text || `HTTP ${response.status}`;
    throw new Error(detail);
  }
  return payload as T;
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
    error: view.status === 'error' ? 'Agent session failed' : null,
    createdAt: timestamp(view.created_at),
    updatedAt: timestamp(view.updated_at),
  };
}

export class McpAgentRunManager {
  private readonly controllers = new Map<string, AbortController>();
  private readonly cancelled = new Set<string>();
  private readonly live = new Map<string, McpAgentRun>();

  constructor(private readonly ctx: ToolContext) {}

  async catalog(): Promise<unknown> {
    const [agents, providers] = await Promise.all([
      jsonRequest<unknown>(this.ctx, '/api/coder/agents'),
      jsonRequest<unknown>(this.ctx, '/api/coder/providers'),
    ]);
    return { agents, providers };
  }

  async start(
    input: StartMcpAgentRunInput,
    authCtx?: AuthContext,
  ): Promise<McpAgentRun> {
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
    const activeRuns = (await this.list(authCtx, 200)).filter(
      (run) =>
        run.profileId === (profile?.id ?? null)
        && (run.status === 'starting' || run.status === 'running'),
    );
    if (activeRuns.length >= (profile?.maxConcurrentRuns ?? 2)) {
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

    const session = await jsonRequest<unknown>(
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

  async get(runId: string, authCtx?: AuthContext): Promise<McpAgentRun> {
    const principal = authCtx?.principal ?? 'local-dev';
    let run = this.live.get(runId) ?? null;
    if (!run) {
      const detail = await jsonRequest<unknown>(
        this.ctx,
        `/api/coder/sessions/${runId}?tail=60&detail=preview`,
      ).catch(() => null);
      run = runFromSession(detail);
    }
    if (!run) throw new Error(`Unknown agent run: ${runId}`);
    if (run.principal !== principal) {
      throw new Error('Agent run belongs to another principal');
    }
    return { ...run };
  }

  async list(authCtx?: AuthContext, limit = 50): Promise<McpAgentRun[]> {
    const principal = authCtx?.principal ?? 'local-dev';
    const sessions = await Promise.all(
      this.ctx.db.listProjects().map((project) =>
        jsonRequest<unknown[]>(
          this.ctx,
          `/api/coder/sessions?project_id=${project.id}&archived=all`,
        ).catch(() => []),
      ),
    );
    const discovered = sessions
      .flat()
      .map(runFromSession)
      .filter((run): run is McpAgentRun => run?.principal === principal);
    const merged = new Map(discovered.map((run) => [run.id, run]));
    for (const run of this.live.values()) {
      if (run.principal === principal) merged.set(run.id, { ...run });
    }
    return [...merged.values()]
      .sort((left, right) => right.createdAt - left.createdAt)
      .slice(0, Math.max(1, Math.min(200, Math.floor(limit))));
  }

  async cancel(runId: string, authCtx?: AuthContext): Promise<McpAgentRun> {
    const run = await this.get(runId, authCtx);
    if (!['starting', 'running'].includes(run.status)) return run;
    this.cancelled.add(runId);
    this.controllers.get(runId)?.abort();
    await jsonRequest(this.ctx, `/api/coder/sessions/${run.sessionId}/abort`, {
      method: 'POST',
      body: '{}',
    }).catch(() => undefined);
    const updated = {
      ...run,
      status: 'cancelled' as const,
      error: null,
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
      await response.text();
      const detail = await jsonRequest<unknown>(
        this.ctx,
        `/api/coder/sessions/${runId}?tail=60&detail=preview`,
      );
      const persisted = runFromSession(detail);
      const current = this.live.get(runId);
      if (current) {
        this.live.set(runId, {
          ...(persisted ?? current),
          status: 'completed',
          finalText:
            finalAssistantText(detail)
            ?? 'Run completed; open the linked CodeStudio session for the full transcript.',
          error: null,
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
          status: timedOut ? 'interrupted' : 'failed',
          error: timedOut
            ? `Agent run exceeded its ${maxRuntimeMs} ms runtime limit`
            : error instanceof Error
              ? error.message
              : String(error),
          updatedAt: Date.now(),
        });
      }
      if (timedOut) {
        await jsonRequest(this.ctx, `/api/coder/sessions/${runId}/abort`, {
          method: 'POST',
          body: '{}',
        }).catch(() => undefined);
      }
    } finally {
      clearTimeout(timeout);
      this.controllers.delete(runId);
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
