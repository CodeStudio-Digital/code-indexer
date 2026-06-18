/**
 * pm-api — builds the Postman-style `pm` object handed to a script inside the vm.
 * Accumulators (variable updates, request patch, logs, tests) are closed over and
 * returned by `collect()` after the script settles. Phase decides what is exposed:
 * PRE → mutable `pm.request`, no `pm.response`; TEST → `pm.response` + `pm.expect`,
 * read-only request.
 */
import { expect } from './expect.js';
import { UNSET, type RequestPatch, type ScriptPhase, type ScriptTestResult } from './types.js';

export interface PmContext {
  phase: ScriptPhase;
  variables: Record<string, string>; // live, mutable (seeded from env vars)
  request: { method: string; url: string; headers: Record<string, string>; body: string };
  response?: { code: number; status: string; headers: Record<string, string>; body: string; responseTime: number };
  cookies: Map<string, string>;
}

export interface PmBuild {
  pm: unknown;
  /** console.log/warn/error sink wired into the sandbox by index.ts. */
  log(...a: unknown[]): void;
  collect(): { variableUpdates: Record<string, string>; requestPatch?: RequestPatch; consoleLogs: string[]; tests: ScriptTestResult[] };
}

const MAX_LOG_BYTES = 32 * 1024;

export function buildPm(ctx: PmContext): PmBuild {
  const variableUpdates: Record<string, string> = {};
  const consoleLogs: string[] = [];
  const tests: ScriptTestResult[] = [];
  const patch: RequestPatch = { headers: {}, removedHeaders: [] };
  let logBytes = 0;
  const isPre = ctx.phase === 'pre';

  const log = (...a: unknown[]): void => {
    if (logBytes >= MAX_LOG_BYTES) return;
    const line = a.map((x) => (typeof x === 'string' ? x : safe(x))).join(' ');
    logBytes += line.length;
    consoleLogs.push(line);
  };

  const environment = {
    get: (k: string): string | undefined => ctx.variables[k],
    set: (k: string, v: unknown): void => { const s = String(v); ctx.variables[k] = s; variableUpdates[k] = s; },
    unset: (k: string): void => { delete ctx.variables[k]; variableUpdates[k] = UNSET; },
  };

  const request = {
    url: {
      get: (): string => ctx.request.url,
      set: (v: string): void => { guard(); ctx.request.url = v; patch.url = v; },
    },
    method: {
      get: (): string => ctx.request.method,
      set: (v: string): void => { guard(); ctx.request.method = v; patch.method = v; },
    },
    headers: {
      get: (n: string): string | undefined => findHeader(ctx.request.headers, n),
      all: (): Record<string, string> => ({ ...ctx.request.headers }),
      set: (n: string, v: string): void => { guard(); ctx.request.headers[n] = v; patch.headers![n] = v; },
      remove: (n: string): void => { guard(); delete ctx.request.headers[n]; patch.removedHeaders!.push(n); },
    },
    body: {
      get: (): string => ctx.request.body,
      set: (v: string): void => { guard(); ctx.request.body = v; patch.body = v; },
    },
  };
  function guard(): void { if (!isPre) throw new Error('pm.request is read-only in a test script'); }

  const response = ctx.response && {
    code: ctx.response.code,
    status: ctx.response.status,
    responseTime: ctx.response.responseTime,
    headers: {
      get: (n: string): string | undefined => findHeader(ctx.response!.headers, n),
      has: (n: string): boolean => findHeader(ctx.response!.headers, n) !== undefined,
      all: (): Record<string, string> => ({ ...ctx.response!.headers }),
    },
    text: (): string => ctx.response!.body,
    json: (): unknown => JSON.parse(ctx.response!.body),
  };

  const test = (name: string, fn: () => void): void => {
    try { fn(); tests.push({ name, passed: true }); }
    catch (e) { tests.push({ name, passed: false, error: messageOf(e) }); }
  };

  const pm = {
    environment,
    variables: { get: environment.get },
    cookies: { get: (n: string) => ctx.cookies.get(n), has: (n: string) => ctx.cookies.has(n) },
    request,
    response,
    expect,
    test,
  };

  return {
    pm,
    log,
    collect: () => {
      const requestPatch = isPre
        ? {
            ...patch,
            headers: Object.keys(patch.headers!).length ? patch.headers : undefined,
            removedHeaders: patch.removedHeaders!.length ? patch.removedHeaders : undefined,
          }
        : undefined;
      return { variableUpdates, requestPatch, consoleLogs, tests };
    },
  };
}

function findHeader(h: Record<string, string>, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(h)) if (k.toLowerCase() === lower) return v;
  return undefined;
}

function messageOf(e: unknown): string {
  if (e && typeof e === 'object' && 'message' in e) return String((e as { message: unknown }).message);
  return String(e);
}

function safe(x: unknown): string {
  try { return JSON.stringify(x); } catch { return String(x); }
}
