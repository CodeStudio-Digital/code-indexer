/** Postman-compatible scripts execute in an owned worker and a WASM realm. */
import { runScriptAsync } from './async.js';
import type { ScriptResult } from './types.js';
export type { RunCtx } from './context.js';
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


export function runPreScript(input: RunPreInput): Promise<ScriptResult> {
  return runScriptAsync({ phase: 'pre', variables: input.variables, request: input.request, cookies: input.cookies ?? new Map() }, input.source, undefined, input.timeoutMs);
}
export function runTestScript(input: RunTestInput): Promise<ScriptResult> {
  return runScriptAsync({ phase: 'test', variables: input.variables, request: input.request, response: input.response, cookies: input.cookies ?? new Map() }, input.source, undefined, input.timeoutMs);
}
