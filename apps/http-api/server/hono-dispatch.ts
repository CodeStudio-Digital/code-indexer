/**
 * In-process Hono dispatcher — bridges IPC channels to the existing
 * Hono routes WITHOUT opening a TCP listener.
 *
 * Why: extracting every namespace (admin, docs, company,
 * workspace, …) into pure handlers in `@mcp/api-handlers` would take
 * days; meanwhile, the IPC bridge needs to cover every dashboard call.
 * Hono exposes a `.fetch(Request) → Promise<Response>` API that runs
 * the entire middleware + route chain in-process. We marshal IPC
 * payloads into synthetic `Request`s, dispatch them through `app.fetch`,
 * and translate the result back to the IPC bus contract.
 *
 * Trade-off: Hono is technically still in the call stack (it parses
 * the URL, runs middleware, etc.), but there is NO socket, NO TCP,
 * NO port — `app.fetch` is just a function call. From the operator's
 * point of view, `Get-NetTCPConnection -LocalPort 7333` returns empty.
 *
 * As handlers get extracted to `@mcp/api-handlers` (the "real" IPC
 * surface), the dispatch table here shrinks. End state: this file
 * deletes itself once every namespace has a pure handler.
 *
 * Streaming routes (SSE responses) are detected by `accept: text/event-stream`
 * + the `STREAMING_DISPATCH_PATHS` set below. The dispatcher parses
 * the SSE stream and yields each `event:`/`data:` block as a typed frame.
 */

import type { Hono } from 'hono';
// Marks these dispatches as the socket-less in-process path so guards like
// `requireTrustedLocalRequest` (SSH CRUD) don't mistake them for a remote peer.
import { IN_PROCESS_ENV } from '@apps/http-api/server/middleware/local-origin.js';

/**
 * Method path (dotted, as the preload proxy builds it from
 * `window.electronAPI.api.foo.bar`) → `{ method, url(input), body(input) }`.
 *
 * Each entry maps an IPC call to a concrete Hono route. The fn forms
 * exist because some routes take ids in the path (`/projects/:id/...`)
 * and others take JSON bodies — the IPC payload shape is uniform but
 * the Hono shape isn't.
 */
interface DispatchSpec {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  /** Build the URL path from the IPC input. */
  url: (input: Record<string, unknown> | undefined) => string;
  /** Build the request body. Return `undefined` for body-less GET/DELETE. */
  body?: (input: Record<string, unknown> | undefined) => unknown;
  /** Override default Content-Type. */
  contentType?: string;
}

const json = (input: Record<string, unknown> | undefined): unknown => input ?? {};

/**
 * Method paths that return Server-Sent Events. The dispatcher parses
 * the SSE stream and converts each event into an IPC stream frame so
 * the renderer's preload `openStream` consumer sees the same shape as
 * a native pure-handler AsyncIterable.
 */
export const STREAMING_DISPATCH_PATHS = new Set<string>([
  'coder.stream.sendMessage',
  'coder.stream.continueSession',
  'coder.stream.attach',
  'docs.sources.createUrlStream',
  'docs.sources.createPdfStream',
  'docs.sources.createFolderStream',
  'docs.sources.reindexStream',
  'docs.sources.retryEmbeddingsStream',
  'docs.research.stream',
  'company.stream',
]);

/**
 * The route catalogue. Each entry covers an IPC call the renderer is
 * known to make today. Adding a new dashboard call site means either:
 *   (a) adding a row here that maps to an existing Hono route, or
 *   (b) implementing a pure handler in @mcp/api-handlers (preferred).
 *
 * Pure handlers (registered separately via `mountIpcHandlers`) shadow
 * any entry here — the dispatcher is only consulted as a fallback.
 */
export const DISPATCH_TABLE: Record<string, DispatchSpec> = {
  // ─── coder.stream.* ──────────────────────────────────────────
  'coder.stream.sendMessage': {
    method: 'POST',
    url: (i) => `/api/coder/sessions/${uuid(i, 'sessionId')}/messages`,
    body: (i) => stripKeys(i, ['sessionId']),
  },
  'coder.stream.continueSession': {
    method: 'POST',
    url: (i) => `/api/coder/sessions/${uuid(i, 'sessionId')}/continue`,
    body: (i) => stripKeys(i, ['sessionId']),
  },
  'coder.stream.attach': {
    method: 'GET',
    url: (i) => `/api/coder/sessions/${uuid(i, 'sessionId')}/attach`,
  },

  // ─── coder.interaction.* (non-streaming) ─────────────────────
  'coder.interaction.answer': {
    method: 'POST',
    url: (i) => `/api/coder/sessions/${uuid(i, 'sessionId')}/answer`,
    body: (i) => stripKeys(i, ['sessionId']),
  },
  'coder.interaction.planResponse': {
    method: 'POST',
    url: (i) => `/api/coder/sessions/${uuid(i, 'sessionId')}/plan-response`,
    body: (i) => stripKeys(i, ['sessionId']),
  },
  'coder.interaction.tasksResponse': {
    method: 'POST',
    url: (i) => `/api/coder/sessions/${uuid(i, 'sessionId')}/tasks-response`,
    body: (i) => stripKeys(i, ['sessionId']),
  },

  // ─── admin.* ─────────────────────────────────────────────────
  'admin.systemInfo':       { method: 'GET',  url: ()  => `/api/admin/system-info` },
  'admin.workers':          { method: 'GET',  url: ()  => `/api/admin/workers` },
  'admin.providers.list':   { method: 'GET',  url: ()  => `/api/admin/providers` },
  'admin.providers.update': { method: 'PUT',  url: (i) => `/api/admin/providers/${str(i, 'id')}`, body: json },
  'admin.providers.test':   { method: 'POST', url: (i) => `/api/admin/providers/${str(i, 'id')}/test`, body: json },
  'admin.logs':             { method: 'GET',  url: (i) => `/api/admin/logs${qs(i, ['tail', 'level'])}` },

  // ─── docs.* ──────────────────────────────────────────────────
  'docs.sources.list':         { method: 'GET',    url: ()  => `/api/docs/sources` },
  'docs.sources.get':          { method: 'GET',    url: (i) => `/api/docs/sources/${num(i, 'id')}` },
  'docs.sources.delete':       { method: 'DELETE', url: (i) => `/api/docs/sources/${num(i, 'id')}` },
  'docs.sources.createUrl':    { method: 'POST',   url: ()  => `/api/docs/sources/url`, body: json },
  'docs.sources.createUrlStream':    { method: 'POST', url: ()  => `/api/docs/sources/url/stream`, body: json },
  'docs.sources.createPdfStream':    { method: 'POST', url: ()  => `/api/docs/sources/pdf/stream`, body: json },
  'docs.sources.createFolderStream': { method: 'POST', url: ()  => `/api/docs/sources/folder/stream`, body: json },
  'docs.sources.reindexStream':      { method: 'POST', url: (i) => `/api/docs/sources/${num(i, 'id')}/reindex/stream` },
  'docs.sources.retryEmbeddingsStream': { method: 'POST', url: (i) => `/api/docs/sources/${num(i, 'id')}/retry-embeddings/stream` },
  'docs.search':               { method: 'POST',   url: ()  => `/api/docs/search`, body: json },
  'docs.research.stream':      { method: 'POST',   url: ()  => `/api/docs-agent/research/stream`, body: json },


  // ─── company.* ──────────────────────────────────────────────
  'company.sessions.list':       { method: 'GET',  url: (i) => `/api/company/sessions${qs(i, ['projectId', 'archived'])}` },
  'company.sessions.get':        { method: 'GET',  url: (i) => `/api/company/sessions/${uuid(i, 'id')}` },
  'company.sessions.create':     { method: 'POST', url: ()  => `/api/company/sessions`, body: json },
  'company.sessions.update':     { method: 'PATCH', url: (i) => `/api/company/sessions/${uuid(i, 'id')}`, body: json },
  'company.sessions.delete':     { method: 'DELETE', url: (i) => `/api/company/sessions/${uuid(i, 'id')}` },
  'company.stream':              { method: 'GET',  url: (i) => `/api/company/sessions/${uuid(i, 'sessionId')}/stream${qs(i, ['since'])}` },

  // ─── workspace.* ────────────────────────────────────────────
  'workspace.config':            { method: 'GET',  url: ()  => `/api/workspace/config` },
  'workspace.setConfig':         { method: 'PUT',  url: ()  => `/api/workspace/config`, body: json },

};

// ─── small helpers ───────────────────────────────────────────────

function num(i: Record<string, unknown> | undefined, key: string): number {
  const v = i?.[key];
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new Error(`dispatcher: missing numeric "${key}" in IPC input`);
  }
  return v;
}

function str(i: Record<string, unknown> | undefined, key: string): string {
  const v = i?.[key];
  if (typeof v !== 'string' || !v) {
    throw new Error(`dispatcher: missing string "${key}" in IPC input`);
  }
  return encodeURIComponent(v);
}

const CANONICAL_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function uuid(
  i: Record<string, unknown> | undefined,
  key: string,
): string {
  const value = i?.[key];
  if (typeof value !== 'string' || !CANONICAL_UUID.test(value)) {
    throw new Error(`dispatcher: missing canonical UUID "${key}" in IPC input`);
  }
  return value.toLowerCase();
}

function stripKeys(
  i: Record<string, unknown> | undefined,
  drop: readonly string[],
): Record<string, unknown> {
  if (!i) return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(i)) {
    if (!drop.includes(k)) out[k] = v;
  }
  return out;
}

function qs(i: Record<string, unknown> | undefined, keys: readonly string[]): string {
  if (!i) return '';
  const parts: string[] = [];
  for (const k of keys) {
    const v = i[k];
    if (v === undefined || v === null) continue;
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  }
  return parts.length === 0 ? '' : `?${parts.join('&')}`;
}

// ─── dispatcher ──────────────────────────────────────────────────

/**
 * Dispatch a single IPC call via the in-process Hono app.
 * Returns the parsed JSON (or text) response, or throws an Error with
 * `code` + `status` for non-2xx responses.
 *
 * For streams use `dispatchStreaming`.
 */
export async function dispatchHono(
  app: Hono,
  methodPath: string,
  input: unknown,
  signal?: AbortSignal,
): Promise<unknown> {
  const spec = DISPATCH_TABLE[methodPath];
  if (!spec) {
    throw new Error(`dispatcher: no Hono route mapped for "${methodPath}"`);
  }
  const inputObj = (input ?? undefined) as Record<string, unknown> | undefined;
  const baseRequest = buildRequest(spec, inputObj);
  const req = signal ? new Request(baseRequest, { signal }) : baseRequest;
  const res = await app.fetch(req, IN_PROCESS_ENV);
  if (!res.ok) {
    const text = await safeText(res);
    const err = new Error(text || `${methodPath} → HTTP ${res.status}`) as Error & { code?: string; status?: number };
    err.status = res.status;
    err.code = res.status === 404 ? 'not_found' : 'dispatch_error';
    throw err;
  }
  const ct = res.headers.get('content-type') ?? '';
  if (ct.includes('application/json')) return await res.json();
  return await res.text();
}

/**
 * Dispatch a streaming IPC call. Returns an AsyncGenerator that yields
 * one frame per SSE event. Each yielded value matches the SSE `data:`
 * payload parsed as JSON (or the raw string when JSON.parse fails).
 *
 * The generator terminates when the SSE stream closes naturally; if the
 * caller `return()`s early, we abort the underlying fetch via signal.
 */
export async function* dispatchStreaming(
  app: Hono,
  methodPath: string,
  input: unknown,
  signal?: AbortSignal,
): AsyncGenerator<unknown, void, unknown> {
  const spec = DISPATCH_TABLE[methodPath];
  if (!spec) {
    throw new Error(`dispatcher: no Hono route mapped for "${methodPath}"`);
  }
  const inputObj = (input ?? undefined) as Record<string, unknown> | undefined;
  // Build with explicit SSE accept so any negotiation logic on the Hono
  // side picks the streaming branch.
  const headers = new Headers({ accept: 'text/event-stream' });
  if (spec.body) headers.set('content-type', spec.contentType ?? 'application/json');
  const req = new Request(`http://internal${spec.url(inputObj)}`, {
    method: spec.method,
    headers,
    body: spec.body ? JSON.stringify(spec.body(inputObj)) : undefined,
    ...(signal ? { signal } : {}),
  });

  const res = await app.fetch(req, IN_PROCESS_ENV);
  if (!res.ok) {
    const text = await safeText(res);
    const err = new Error(text || `${methodPath} → HTTP ${res.status}`) as Error & { code?: string; status?: number };
    err.status = res.status;
    err.code = res.status === 404 ? 'not_found' : 'dispatch_error';
    throw err;
  }
  const body = res.body;
  if (!body) return;

  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buf = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      // SSE events are delimited by a blank line.
      let nl = buf.indexOf('\n\n');
      while (nl >= 0) {
        const block = buf.slice(0, nl);
        buf = buf.slice(nl + 2);
        const frame = parseSseBlock(block);
        if (frame !== undefined) yield frame;
        nl = buf.indexOf('\n\n');
      }
    }
    // Flush trailing event without terminating blank line (rare, but
    // pumpBusToSSE has occasionally emitted one).
    if (buf.trim().length > 0) {
      const frame = parseSseBlock(buf);
      if (frame !== undefined) yield frame;
    }
  } finally {
    if (signal?.aborted) {
      await reader.cancel(signal.reason).catch(() => undefined);
    }
    reader.releaseLock();
  }
}

function buildRequest(
  spec: DispatchSpec,
  input: Record<string, unknown> | undefined,
): Request {
  const headers = new Headers();
  let bodyPayload: BodyInit | undefined;
  if (spec.body) {
    headers.set('content-type', spec.contentType ?? 'application/json');
    bodyPayload = JSON.stringify(spec.body(input));
  }
  return new Request(`http://internal${spec.url(input)}`, {
    method: spec.method,
    headers,
    body: bodyPayload,
  });
}

function parseSseBlock(block: string): unknown | undefined {
  // Each block can have multiple `data:` lines (per the SSE spec, they
  // join with '\n'). Other field lines (event:, id:, retry:) are kept
  // attached to the event object so consumers like `coderEvent.type`
  // still receive the event name.
  const lines = block.split('\n');
  let eventName: string | undefined;
  const dataLines: string[] = [];
  for (const raw of lines) {
    if (!raw) continue;
    const colonIx = raw.indexOf(':');
    const field = colonIx >= 0 ? raw.slice(0, colonIx) : raw;
    const value = colonIx >= 0 ? raw.slice(colonIx + 1).replace(/^ /, '') : '';
    if (field === 'event') eventName = value;
    else if (field === 'data') dataLines.push(value);
    // 'id'/'retry'/comment lines ignored.
  }
  if (dataLines.length === 0) return undefined;
  const raw = dataLines.join('\n');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = raw;
  }
  // The coder bus emits `event: <name>\ndata: <json>`. The renderer's
  // pre-existing consumers expect a CoderEvent with a `.type` discriminator,
  // not an `event:` field. So we fold `eventName` INTO the object when both
  // are present and the data is an object.
  if (eventName && parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    return { type: eventName, ...(parsed as Record<string, unknown>) };
  }
  if (eventName) return { type: eventName, data: parsed };
  return parsed;
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}
