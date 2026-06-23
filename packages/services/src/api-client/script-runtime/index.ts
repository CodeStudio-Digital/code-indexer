/**
 * Script runtime — runs a request's pre-request / test script inside an
 * isolated-vm Isolate (a real V8 isolate with NO Node bindings), so a script can
 * never reach the host realm: there is no `process`/`require`, and the
 * host-object constructor-chain escape that makes `node:vm` unsafe
 * (`Object.constructor("return process")()`) is impossible because NO host object
 * is ever exposed to the isolate.
 *
 * The pm/expect/console surface is built INSIDE the isolate (see bootstrap.ts);
 * inputs and the collected result cross the boundary ONLY as JSON strings, never
 * as live objects. Synchronous by design — async globals are removed inside the
 * isolate and the isolate's wall-clock `timeout` + `memoryLimit` bound a runaway
 * script. vm-realm errors are surfaced by message text, never `instanceof`.
 *
 * REQUIRES a native build of isolated-vm: `pnpm node:rebuild` for the test ABI
 * and `pnpm electron:rebuild` for the app (needs the VS C++ Build Tools on
 * Windows). Until then this module loads but every run throws at `new ivm.Isolate`.
 */
import { createRequire } from 'node:module';
import type { Isolate as IvmIsolate } from 'isolated-vm';
import { BOOTSTRAP } from './bootstrap.js';
import { EMPTY_SCRIPT_RESULT, UNSET, type RequestPatch, type ScriptPhase, type ScriptResult, type ScriptTestResult } from './types.js';

const DEFAULT_TIMEOUT_MS = 2_000;
const MAX_TIMEOUT_MS = 5_000;
const MEMORY_LIMIT_MB = 128;

/** Just the slice of the isolated-vm module surface we use. */
interface IvmModule { Isolate: new (opts?: { memoryLimit?: number }) => IvmIsolate }

// Load the native isolated-vm module LAZILY (and tolerantly) via createRequire so
// that merely importing this module — and thus execute-request / the regression
// runner — never crashes when the native binary isn't built for the current ABI.
// Until `pnpm node:rebuild` / `pnpm electron:rebuild` runs, scripts degrade to a
// clear error and the request itself still sends.
const nodeRequire = createRequire(import.meta.url);
let ivmModule: IvmModule | null | undefined;
function getIvm(): IvmModule | null {
  if (ivmModule !== undefined) return ivmModule;
  try { ivmModule = nodeRequire('isolated-vm') as IvmModule; }
  catch { ivmModule = null; }
  return ivmModule;
}

interface RunCtx {
  phase: ScriptPhase;
  variables: Record<string, string>;
  request: { method: string; url: string; headers: Record<string, string>; body: string };
  response?: { code: number; status: string; headers: Record<string, string>; body: string; responseTime: number };
  cookies: Map<string, string>;
}

export interface RunPreInput {
  source: string;
  variables: Record<string, string>;
  request: { method: string; url: string; headers: Record<string, string>; body: string };
  cookies?: Map<string, string>;
  timeoutMs?: number;
}

export interface RunTestInput extends RunPreInput {
  response: { code: number; status: string; headers: Record<string, string>; body: string; responseTime: number };
}

export function runPreScript(input: RunPreInput): ScriptResult {
  return run(
    { phase: 'pre', variables: input.variables, request: input.request, cookies: input.cookies ?? new Map() },
    input.source,
    input.timeoutMs,
  );
}

export function runTestScript(input: RunTestInput): ScriptResult {
  return run(
    { phase: 'test', variables: input.variables, request: input.request, response: input.response, cookies: input.cookies ?? new Map() },
    input.source,
    input.timeoutMs,
  );
}

interface Collected {
  variableUpdates?: Record<string, string>;
  requestPatch?: RequestPatch;
  consoleLogs?: string[];
  tests?: ScriptTestResult[];
}

function run(ctx: RunCtx, source: string, timeoutMs?: number): ScriptResult {
  if (!source || !source.trim()) return { ...EMPTY_SCRIPT_RESULT, variableUpdates: {}, consoleLogs: [], tests: [] };
  const t0 = Date.now();
  const ivm = getIvm();
  if (!ivm) {
    return { ...EMPTY_SCRIPT_RESULT, variableUpdates: {}, consoleLogs: [], tests: [], durationMs: Date.now() - t0, error: 'script runtime unavailable: the isolated-vm native module is not built for this runtime — run `pnpm electron:rebuild` (app) or `pnpm node:rebuild` (tests)' };
  }
  const timeout = Math.min(MAX_TIMEOUT_MS, Math.max(100, timeoutMs ?? DEFAULT_TIMEOUT_MS));
  const isolate = new ivm.Isolate({ memoryLimit: MEMORY_LIMIT_MB });
  let error: string | undefined;
  let collected: Collected = {};
  try {
    const context = isolate.createContextSync();
    // Inputs cross as ONE JSON string (a primitive — no live host reference).
    const inputJson = JSON.stringify({
      phase: ctx.phase,
      variables: ctx.variables,
      request: ctx.request,
      response: ctx.response ?? null,
      cookies: [...ctx.cookies.entries()],
      UNSET,
    });
    context.global.setSync('__PM_INPUT__', inputJson);
    // Build the pm/expect/console surface inside the isolate.
    isolate.compileScriptSync(BOOTSTRAP).runSync(context, { timeout });
    // Run the user script. A top-level throw / timeout is the script-level error.
    try {
      isolate.compileScriptSync(`(function(){\n${source}\n})()`).runSync(context, { timeout });
    } catch (e) {
      error = messageOf(e);
    }
    // Collect accumulators as a JSON string. After a timeout/OOM the isolate may
    // be torn down, so a failure here is expected and non-fatal — keep the error.
    try {
      const out = isolate.compileScriptSync('__pmCollect()').runSync(context, { timeout, copy: true });
      if (typeof out === 'string') collected = JSON.parse(out) as Collected;
    } catch { /* isolate gone after a runaway script — keep error + empty result */ }
  } catch (e) {
    error = error ?? messageOf(e);
  } finally {
    try { isolate.dispose(); } catch { /* already disposed */ }
  }

  applyToCtx(ctx, collected);
  return {
    variableUpdates: collected.variableUpdates ?? {},
    requestPatch: ctx.phase === 'pre' ? collected.requestPatch : undefined,
    consoleLogs: collected.consoleLogs ?? [],
    tests: collected.tests ?? [],
    error,
    durationMs: Date.now() - t0,
  };
}

/**
 * Apply the script's recorded changes back to the live host ctx so the caller
 * (execute-request) keeps reading the mutated vars/request exactly as it did when
 * the pm closures mutated them in place.
 */
function applyToCtx(ctx: RunCtx, c: Collected): void {
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

function messageOf(e: unknown): string {
  return e && typeof e === 'object' && 'message' in e ? String((e as { message: unknown }).message) : String(e);
}
