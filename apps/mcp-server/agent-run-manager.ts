import { randomUUID } from 'node:crypto';
import type { AuthContext } from '@mcp/services/auth/domain/auth-context.js';
import { McpAgentRunStore, type McpAgentRun } from '@mcp/store/mcp-agent-run-store.js';
import type { ToolContext } from './context.js';
import {
  buildMcpAgentSessionCreatePayload,
  type StartMcpAgentRunInput,
} from './agent-run-contract.js';

export type { StartMcpAgentRunInput } from './agent-run-contract.js';

function baseUrl(ctx: ToolContext): string {
  return `http://127.0.0.1:${ctx.config.dashboard.port}`;
}

async function jsonRequest<T>(ctx: ToolContext, path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${baseUrl(ctx)}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  const text = await response.text();
  let payload: unknown = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = text; }
  if (!response.ok) {
    const detail = payload && typeof payload === 'object' && 'error' in payload
      ? String((payload as { error: unknown }).error)
      : text || `HTTP ${response.status}`;
    throw new Error(detail);
  }
  return payload as T;
}

function finalAssistantText(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const root = payload as Record<string, unknown>;
  const candidates = [root.messages, (root.session as Record<string, unknown> | undefined)?.messages];
  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) continue;
    for (let index = candidate.length - 1; index >= 0; index -= 1) {
      const message = candidate[index] as Record<string, unknown>;
      if (message.role !== 'assistant') continue;
      if (typeof message.content === 'string' && message.content.trim()) return message.content;
      if (typeof message.text === 'string' && message.text.trim()) return message.text;
    }
  }
  return null;
}

export class McpAgentRunManager {
  private readonly store: McpAgentRunStore;
  private readonly controllers = new Map<string, AbortController>();
  private readonly cancelled = new Set<string>();

  constructor(private readonly ctx: ToolContext) {
    this.store = new McpAgentRunStore(ctx.config.dbPath);
    this.store.interruptActiveRuns();
  }

  async catalog(): Promise<unknown> {
    const [agents, providers] = await Promise.all([
      jsonRequest<unknown>(this.ctx, '/api/coder/agents'),
      jsonRequest<unknown>(this.ctx, '/api/coder/providers'),
    ]);
    return { agents, providers };
  }

  async start(input: StartMcpAgentRunInput, authCtx?: AuthContext): Promise<McpAgentRun> {
    const principal = authCtx?.principal ?? 'local-dev';
    const profile = authCtx?.policy ?? null;
    if (profile?.agentAllowlist.length && !profile.agentAllowlist.includes(input.agentId)) {
      throw new Error(`Agent '${input.agentId}' is outside connection profile '${profile.name}'`);
    }
    if (this.store.countActive(principal, profile?.id ?? null) >= (profile?.maxConcurrentRuns ?? 2)) {
      throw new Error(`Concurrent agent-run limit reached (${profile?.maxConcurrentRuns ?? 2})`);
    }

    const project = this.ctx.db.listProjects().find((candidate) =>
      candidate.name === input.projectName || String(candidate.id) === input.projectName,
    );
    if (!project) throw new Error(`Unknown project: ${input.projectName}`);

    const runId = randomUUID();
    this.store.create({
      id: runId,
      principal,
      profileId: profile?.id ?? null,
      sessionId: null,
      projectId: project.id,
      agentId: input.agentId,
      status: 'starting',
      taskPreview: input.task.slice(0, 500),
      finalText: null,
      error: null,
    });

    try {
      const session = await jsonRequest<{ id: number }>(this.ctx, '/api/coder/sessions', {
        method: 'POST',
        body: JSON.stringify(buildMcpAgentSessionCreatePayload(input, project.id)),
      });
      const run = this.store.update(runId, { sessionId: session.id, status: 'running' })!;
      void this.execute(runId, session.id, input.task, profile?.maxRuntimeMs ?? 1_800_000);
      return run;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.store.update(runId, { status: 'failed', error: message });
      throw error;
    }
  }

  get(runId: string, authCtx?: AuthContext): McpAgentRun {
    const run = this.store.get(runId);
    if (!run) throw new Error(`Unknown agent run: ${runId}`);
    const principal = authCtx?.principal ?? 'local-dev';
    if (run.principal !== principal) throw new Error('Agent run belongs to another principal');
    return run;
  }

  list(authCtx?: AuthContext, limit = 50): McpAgentRun[] {
    return this.store.listForPrincipal(authCtx?.principal ?? 'local-dev', limit);
  }

  async cancel(runId: string, authCtx?: AuthContext): Promise<McpAgentRun> {
    const run = this.get(runId, authCtx);
    if (!['starting', 'running'].includes(run.status)) return run;
    this.cancelled.add(runId);
    this.controllers.get(runId)?.abort();
    if (run.sessionId) {
      await jsonRequest(this.ctx, `/api/coder/sessions/${run.sessionId}/abort`, {
        method: 'POST',
        body: '{}',
      }).catch(() => undefined);
    }
    return this.store.update(runId, { status: 'cancelled', error: null })!;
  }

  private async execute(runId: string, sessionId: number, task: string, maxRuntimeMs: number): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), maxRuntimeMs);
    this.controllers.set(runId, controller);
    try {
      const response = await fetch(`${baseUrl(this.ctx)}/api/coder/sessions/${sessionId}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
        body: JSON.stringify({ content: task }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error((await response.text()) || `Agent stream failed: HTTP ${response.status}`);
      // Draining the stream is what keeps the underlying run attached until
      // the server emits its terminal event.
      await response.text();
      const detail = await jsonRequest<unknown>(
        this.ctx,
        `/api/coder/sessions/${sessionId}?tail=60&detail=preview`,
      );
      this.store.update(runId, {
        status: 'completed',
        finalText: finalAssistantText(detail) ?? 'Run completed; open the linked CodeStudio session for the full transcript.',
        error: null,
      });
    } catch (error) {
      if (this.cancelled.has(runId)) return;
      const timedOut = controller.signal.aborted;
      this.store.update(runId, {
        status: timedOut ? 'interrupted' : 'failed',
        error: timedOut
          ? `Agent run exceeded its ${maxRuntimeMs} ms runtime limit`
          : error instanceof Error ? error.message : String(error),
      });
      if (timedOut) {
        await jsonRequest(this.ctx, `/api/coder/sessions/${sessionId}/abort`, {
          method: 'POST', body: '{}',
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
