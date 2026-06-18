/**
 * Script runtime — run a request's pre-request / test script in node:vm.
 *
 * Synchronous by design: scripts are glue, not programs. A fresh vm context
 * ships ALL standard globals (incl. Promise/queueMicrotask), so we delete the
 * async-capable ones before running — otherwise a script could schedule a
 * microtask loop (`Promise.resolve().then(() => { while(true){} })`) that
 * returns instantly from the timed call and then hangs the host thread. With
 * them removed, the vm `timeout` deterministically kills a runaway sync loop.
 * node:vm is NOT a security boundary; the user/agent is local and trusted.
 * vm-realm errors are detected by message text, never `instanceof`.
 */
import { createContext, runInContext } from 'node:vm';
import { buildPm, type PmContext } from './pm-api.js';
import { EMPTY_SCRIPT_RESULT, type ScriptResult } from './types.js';

// Globals that let code escape the synchronous timeout into a later tick.
const ASYNC_GLOBALS = ['Promise', 'queueMicrotask', 'setTimeout', 'setInterval', 'setImmediate', 'WeakRef', 'FinalizationRegistry'];

const DEFAULT_TIMEOUT_MS = 2_000;
const MAX_TIMEOUT_MS = 5_000;

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
  return run('pre', input.source, {
    phase: 'pre',
    variables: input.variables,
    request: input.request,
    cookies: input.cookies ?? new Map(),
  }, input.timeoutMs);
}

export function runTestScript(input: RunTestInput): ScriptResult {
  return run('test', input.source, {
    phase: 'test',
    variables: input.variables,
    request: input.request,
    response: input.response,
    cookies: input.cookies ?? new Map(),
  }, input.timeoutMs);
}

function run(_phase: string, source: string, ctx: PmContext, timeoutMs?: number): ScriptResult {
  if (!source || !source.trim()) return { ...EMPTY_SCRIPT_RESULT, variableUpdates: {}, consoleLogs: [], tests: [] };
  const t0 = Date.now();
  const build = buildPm(ctx);
  const console = { log: build.log, warn: build.log, error: build.log, info: build.log, debug: build.log };
  const sandbox = {
    pm: build.pm,
    console,
    JSON, Math, Number, String, Boolean, Array, Object, Set, Map, Date, RegExp, Error,
    parseInt, parseFloat, isNaN, isFinite, encodeURIComponent, decodeURIComponent, btoa, atob,
  };
  const timeout = Math.min(MAX_TIMEOUT_MS, Math.max(100, timeoutMs ?? DEFAULT_TIMEOUT_MS));
  let error: string | undefined;
  try {
    const context = createContext(sandbox, { microtaskMode: 'afterEvaluate' });
    runInContext(`${ASYNC_GLOBALS.map((g) => `try{delete globalThis.${g}}catch(e){}`).join('')}`, context);
    runInContext(`(function(){\n${source}\n})()`, context, { timeout });
  } catch (e) {
    error = e && typeof e === 'object' && 'message' in e ? String((e as { message: unknown }).message) : String(e);
  }
  const collected = build.collect();
  return { ...collected, error, durationMs: Date.now() - t0 };
}
