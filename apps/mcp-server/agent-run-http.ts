import { readBoundedJsonResponse } from '@mcp/shared/utils/bounded-json-response.js';
import type { ToolContext } from './context.js';

export function agentRunBaseUrl(ctx: ToolContext): string {
  return `http://127.0.0.1:${ctx.config.dashboard.port}`;
}

export class AgentRunHttpError extends Error {
  constructor(readonly status: number, detail: string) { super(detail); }
}

export function agentReadSignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(10_000);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/** Bound response bytes as well as header/body time. No request signal is
 * retained by the shared run manager across independent MCP calls. */
export async function jsonRequest<T>(ctx: ToolContext, path: string, init?: RequestInit,
  transport: typeof fetch = fetch): Promise<T> {
  const signal = agentReadSignal(init?.signal ?? undefined);
  signal.throwIfAborted();
  const response = await transport(`${agentRunBaseUrl(ctx)}${path}`, {
    ...init, signal, redirect: 'error',
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  let payload: unknown;
  try { payload = await readBoundedJsonResponse(response, signal, 8 * 1024 * 1024); }
  catch (error) {
    signal.throwIfAborted();
    if (!response.ok && error instanceof SyntaxError) throw new AgentRunHttpError(response.status, `HTTP ${response.status}`);
    throw error;
  }
  if (!response.ok) {
    const detail = payload && typeof payload === 'object' && 'error' in payload
      ? String(payload.error).slice(0, 4096) : `HTTP ${response.status}`;
    throw new AgentRunHttpError(response.status, detail);
  }
  return payload as T;
}

export function agentRunPath(runId: string): string {
  if (typeof runId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(runId)) {
    throw new Error('Invalid agent run id');
  }
  return `/api/coder/sessions/${encodeURIComponent(runId)}`;
}
