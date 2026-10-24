import { UNSET, type RequestPatch, type ScriptPhase, type ScriptTestResult } from './types.js';

export interface RunCtx {
  phase: ScriptPhase;
  variables: Record<string, string>;
  request: { method: string; url: string; headers: Record<string, string>; body: string };
  response?: { code: number; status: string; headers: Record<string, string>; body: string; responseTime: number };
  cookies: Map<string, string>;
}

export interface Collected {
  variableUpdates?: Record<string, string>;
  requestPatch?: RequestPatch;
  consoleLogs?: string[];
  tests?: ScriptTestResult[];
}

export function applyToCtx(ctx: RunCtx, c: Collected): void {
  for (const [k, v] of Object.entries(c.variableUpdates ?? {})) {
    if (v === UNSET) delete ctx.variables[k]; else ctx.variables[k] = v;
  }
  const p = c.requestPatch;
  if (ctx.phase === 'pre' && p) {
    if (p.url !== undefined) ctx.request.url = p.url;
    if (p.method !== undefined) ctx.request.method = p.method;
    if (p.headers) for (const [k, v] of Object.entries(p.headers)) ctx.request.headers[k] = v;
    if (p.removedHeaders) for (const h of p.removedHeaders) delete ctx.request.headers[h];
    if (p.body !== undefined) ctx.request.body = p.body;
  }
}

export function messageOf(e: unknown): string {
  return e && typeof e === 'object' && 'message' in e ? String((e as { message: unknown }).message) : String(e);
}
