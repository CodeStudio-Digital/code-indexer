/**
 * regression-runner — replay a collection's VERIFIED requests with no LLM and
 * assert each one. Pure: same shared HTTP engine as the live "send" route, so
 * a green run here means the API still behaves as documented. Powers both the
 * in-app "Run all" button and (later) a CLI for CI.
 */
import type { CookieJar } from '@mcp/shared/utils/http-engine.js';
import { executeRequest, ApiRequestOutcomeUnknown, type ExecRequest, type ExecuteResult, type ExecuteInput } from './execute-request.js';
import { UNSET, type ScriptTestResult } from './script-runtime/types.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export interface RunRequestLike extends ExecRequest {
  id: number;
  name: string;
  expected_status: number | null;
  assert_json: string | null;
}

export interface AssertionResult {
  requestId: number;
  name: string;
  method: string;
  expected: number | null;
  actual: number | null;
  ok: boolean;
  skipped?: boolean;
  reason?: string;
  /** pm.test() outcomes (pre + test phases) when the request has scripts. */
  tests?: ScriptTestResult[];
}

export interface RunReport {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  status: 'passed' | 'failed' | 'error';
  results: AssertionResult[];
}

const typeOf = (v: unknown): string => (Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v);

/** Structural match: `skeleton` describes expected keys+types, not values. */
function matchShape(skeleton: unknown, value: unknown, path = ''): string | null {
  if (skeleton === 'any' || skeleton == null) return null;
  if (typeof skeleton === 'string') {
    return typeOf(value) === skeleton ? null : `${path || 'body'}: expected ${skeleton}, got ${typeOf(value)}`;
  }
  if (Array.isArray(skeleton)) {
    if (!Array.isArray(value)) return `${path || 'body'}: expected array`;
    if (skeleton.length && value.length) return matchShape(skeleton[0], value[0], `${path}[0]`);
    return null;
  }
  if (typeof skeleton === 'object') {
    if (typeOf(value) !== 'object') return `${path || 'body'}: expected object`;
    for (const [k, sub] of Object.entries(skeleton)) {
      const child = (value as Record<string, unknown>)[k];
      if (child === undefined) return `missing key ${path ? `${path}.` : ''}${k}`;
      const r = matchShape(sub, child, `${path ? `${path}.` : ''}${k}`);
      if (r) return r;
    }
  }
  return null;
}

function assertResponse(
  req: RunRequestLike,
  res: { status: number; headers: Record<string, string | string[] | undefined>; body: string },
): { ok: boolean; reason?: string } {
  if (req.expected_status != null && res.status !== req.expected_status) {
    return { ok: false, reason: `expected ${req.expected_status}, got ${res.status}` };
  }
  if (!req.assert_json) return { ok: true };
  let asserts: { shape?: unknown; headers?: Record<string, string> };
  try { asserts = JSON.parse(req.assert_json); } catch { return { ok: true }; }
  if (asserts.shape) {
    let parsed: unknown;
    try { parsed = JSON.parse(res.body); } catch { return { ok: false, reason: 'body is not JSON' }; }
    const r = matchShape(asserts.shape, parsed);
    if (r) return { ok: false, reason: r };
  }
  for (const [h, expected] of Object.entries(asserts.headers ?? {})) {
    const got = res.headers[h.toLowerCase()];
    const val = Array.isArray(got) ? got.join(', ') : (got ?? '');
    if (expected && val !== expected) return { ok: false, reason: `header ${h}: expected '${expected}', got '${val}'` };
  }
  return { ok: true };
}

/** Legacy status/shape assert AND every pm.test must pass; scripts errors fail. */
function mergeVerdict(req: RunRequestLike, exec: ExecuteResult, tests: ScriptTestResult[]): { ok: boolean; reason?: string } {
  const legacy = assertResponse(req, { status: exec.status, headers: exec.headers, body: exec.body });
  if (!legacy.ok) return legacy;
  const failedTest = tests.find((t) => !t.passed);
  if (failedTest) return { ok: false, reason: `${failedTest.name}: ${failedTest.error ?? 'failed'}` };
  const scriptError = exec.preScript?.error ?? exec.testScript?.error;
  if (scriptError) return { ok: false, reason: `script error: ${scriptError}` };
  return { ok: true };
}

export async function runCollection(opts: {
  requests: RunRequestLike[];
  baseUrl: string;
  variables: Record<string, string>;
  jar?: CookieJar;
  includeMutating?: boolean;
  onProgress?: (r: AssertionResult) => void;
  signal?: AbortSignal;
  /** SSRF guard — refuse private/loopback destinations. */
  blockPrivateHosts?: boolean;
  /** File-body containment root + whether absolute paths are allowed. */
  fileRoot?: string;
  allowAbsoluteFiles?: boolean;
  /** Response read cap — must match the send route so large bodies aren't truncated. */
  maxBytes?: number;
  send?: ExecuteInput['send'];
  beforeDispatch?: (request: RunRequestLike) => void;
}): Promise<RunReport> {
  const results: AssertionResult[] = [];
  let passed = 0, failed = 0, skipped = 0;
  let aborted = false;
  // Run-level shared variable scope: a login request that sets {{token}} makes
  // it available to later requests (Postman semantics; mirrors the shared jar).
  const runVars = { ...opts.variables };

  for (const req of opts.requests) {
    if (opts.signal?.aborted) { aborted = true; break; }
    const base: AssertionResult = { requestId: req.id, name: req.name, method: req.method, expected: req.expected_status, actual: null, ok: false };

    if (req.expected_status == null) {
      const r = { ...base, ok: false, skipped: true, reason: 'not verified' };
      skipped++; results.push(r); opts.onProgress?.(r); continue;
    }
    if (!SAFE_METHODS.has(req.method.toUpperCase()) && !opts.includeMutating) {
      const r = { ...base, ok: false, skipped: true, reason: `${req.method} skipped (mutating)` };
      skipped++; results.push(r); opts.onProgress?.(r); continue;
    }

    try {
      const exec = await executeRequest({
        request: req, baseUrl: opts.baseUrl, variables: runVars,
        jar: opts.jar, signal: opts.signal, runScripts: true,
        blockPrivateHosts: opts.blockPrivateHosts,
        fileRoot: opts.fileRoot, allowAbsoluteFiles: opts.allowAbsoluteFiles,
        maxBytes: opts.maxBytes,
        send: opts.send, allowMutating: !!opts.includeMutating,
        beforeDispatch: () => opts.beforeDispatch?.(req),
      });
      // Chain script var updates into the shared scope for the next request.
      for (const [k, v] of Object.entries(exec.variableUpdates)) {
        if (v === UNSET) delete runVars[k]; else runVars[k] = v;
      }
      const tests = [...(exec.preScript?.tests ?? []), ...(exec.testScript?.tests ?? [])];
      const verdict = mergeVerdict(req, exec, tests);
      const r: AssertionResult = { ...base, actual: exec.status, ok: verdict.ok, reason: verdict.reason, tests: tests.length ? tests : undefined };
      verdict.ok ? passed++ : failed++;
      results.push(r); opts.onProgress?.(r);
    } catch (e) {
      if (e instanceof ApiRequestOutcomeUnknown) throw e;
      const r = { ...base, ok: false, reason: e instanceof Error ? e.message : String(e) };
      failed++; results.push(r); opts.onProgress?.(r);
      if (opts.signal?.aborted) { aborted = true; break; }
    }
  }

  return {
    total: results.length,
    passed, failed, skipped,
    // An aborted run is incomplete — never record the partial result as a green
    // 'passed' run (the sidebar dots + run history would falsely show success).
    status: aborted ? 'error' : (failed > 0 ? 'failed' : 'passed'),
    results,
  };
}
