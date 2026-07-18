/**
 * execute-request — the single pipeline both the live "send" route and the
 * non-LLM regression runner use, so a manual send and a CI replay run byte-
 * identical code:  pre-script → auth → build URL → encode body → send → test-script.
 *
 * Only transport + scripts + auth live here. History/last_status stay in the
 * route; assert/verdict stays in the runner.
 */
import {
  type CookieJar, jarSnapshot, sendHttp,
} from '@mcp/shared/utils/http-engine.js';
import {
  buildUrlFromRows, normalizeKvList, parseMap, resolveMap, resolveTemplate,
} from './request-builder.js';
import { encodeBody, type BodyLike } from './body-encode.js';
import { computeAuth, mergeAuthHeaders } from './apply-auth.js';
import { parseAuth } from './auth-types.js';
import { runPreScript, runTestScript } from './script-runtime/index.js';
import type { ScriptResult } from './script-runtime/types.js';

export interface ExecRequest extends BodyLike {
  method: string;
  path_template: string;
  headers_json: string;
  query_json: string;
  pre_request_script?: string | null;
  test_script?: string | null;
  auth_type?: string | null;
  auth_json?: string | null;
}

export interface ExecuteInput {
  request: ExecRequest;
  baseUrl: string;
  variables: Record<string, string>;
  jar?: CookieJar;
  insecure?: boolean;
  timeoutMs?: number;
  maxBytes?: number;
  signal?: AbortSignal;
  /** Run pre/test scripts (default true). */
  runScripts?: boolean;
  /** Refuse private/loopback/link-local/metadata destinations (SSRF guard). */
  blockPrivateHosts?: boolean;
  /** Project root that file-backed bodies (binary/form-data) must stay within. */
  fileRoot?: string;
  /** Allow absolute / out-of-root file paths for bodies (trusted local caller). */
  allowAbsoluteFiles?: boolean;
}

export interface ExecuteResult {
  status: number;
  statusText: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
  ms: number;
  url: string;
  size: number;
  /** False when size is only the observed lower bound of a cancelled transfer. */
  sizeExact: boolean;
  truncated: boolean;
  /** Merged pre+test variable updates (UNSET sentinel = delete). */
  variableUpdates: Record<string, string>;
  preScript?: ScriptResult;
  testScript?: ScriptResult;
}

export async function executeRequest(input: ExecuteInput): Promise<ExecuteResult> {
  const req = input.request;
  const vars = { ...input.variables };
  const run = input.runScripts !== false;
  const t0 = Date.now();

  // Seed with UNRESOLVED templates so a pre-script can read/override `{{token}}`.
  const seed = {
    method: req.method,
    url: req.path_template,
    headers: parseMap(req.headers_json),
    body: req.body_json ?? '',
  };

  // ── Pre-request script (mutates `vars` and `seed` in place via pm closures) ──
  let preScript: ScriptResult | undefined;
  if (run && req.pre_request_script?.trim()) {
    preScript = runPreScript({ source: req.pre_request_script, variables: vars, request: seed, cookies: new Map() });
  }

  // ── Build URL (rows authoritative for query; templates resolve here) ──
  const url = buildUrlFromRows(input.baseUrl, seed.url, normalizeKvList(req.query_json), vars);

  // ── Headers: explicit (resolved) then auth (explicit wins) ──
  const headers = resolveMap(seed.headers, vars);
  const auth = computeAuth(parseAuth(req.auth_type, req.auth_json), vars, true);
  mergeAuthHeaders(headers, auth.headers);
  for (const [k, v] of Object.entries(auth.query)) url.searchParams.append(k, v);

  // ── Body ──
  let outBody: string | Buffer | undefined;
  let defaultCt: string | undefined;
  const patchedBody = preScript?.requestPatch?.body;
  if (patchedBody !== undefined) {
    // A pre-script replaced the body with a raw string. Keep the body kind's
    // default content-type (json/urlencoded/graphql) so a tweaked JSON body
    // still sends application/json, matching the non-script path.
    outBody = resolveTemplate(patchedBody, vars);
    defaultCt = defaultContentType(req.body_kind);
  } else {
    const enc = await encodeBody(req, vars, { fileRoot: input.fileRoot, allowAbsoluteFiles: input.allowAbsoluteFiles });
    outBody = enc.body;
    defaultCt = enc.contentType;
  }
  if (defaultCt) {
    const hasCt = Object.keys(headers).some((h) => h.toLowerCase() === 'content-type');
    if (defaultCt.startsWith('multipart/form-data')) {
      // The random boundary is intrinsic to the encoded body, so it MUST be the
      // advertised one — override any user-set Content-Type (a multipart CT
      // without the matching boundary makes the whole body unparseable).
      for (const h of Object.keys(headers)) if (h.toLowerCase() === 'content-type') delete headers[h];
      headers['content-type'] = defaultCt;
    } else if (!hasCt) {
      headers['content-type'] = defaultCt;
    }
  }

  // ── Send ──
  const res = await sendHttp({
    url, method: seed.method, headers, body: outBody,
    jar: input.jar, insecure: input.insecure, timeoutMs: input.timeoutMs,
    maxBytes: input.maxBytes, blockPrivateHosts: input.blockPrivateHosts, signal: input.signal,
  });
  const ms = Date.now() - t0;

  // ── Test script ──
  let testScript: ScriptResult | undefined;
  if (run && req.test_script?.trim()) {
    testScript = runTestScript({
      source: req.test_script,
      variables: vars,
      request: seed,
      response: { code: res.status, status: res.statusText, headers: flattenHeaders(res.headers), body: res.body, responseTime: ms },
      cookies: new Map(input.jar ? jarSnapshot(input.jar, url.host).map((c) => [c.name, c.value]) : []),
    });
  }

  return {
    status: res.status, statusText: res.statusText, headers: res.headers, body: res.body,
    ms, url: url.href, size: res.size, sizeExact: res.sizeExact, truncated: res.truncated,
    variableUpdates: { ...(preScript?.variableUpdates ?? {}), ...(testScript?.variableUpdates ?? {}) },
    preScript, testScript,
  };
}

/** Default content-type for a body kind (json/urlencoded/graphql); none otherwise. */
function defaultContentType(kind: string): string | undefined {
  const k = kind === 'form' ? 'urlencoded' : kind;
  if (k === 'json' || k === 'graphql') return 'application/json';
  if (k === 'urlencoded') return 'application/x-www-form-urlencoded';
  return undefined;
}

function flattenHeaders(h: Record<string, string | string[] | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) out[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : String(v ?? '');
  return out;
}
