/**
 * Transport-agnostic client for the @mcp/api-bus surface.
 *
 * Two callsite shapes:
 *   - `apiCall('projects.list', undefined)` — Promise<T>
 *   - `apiStream('coder.stream.sendMessage', input)` — AsyncIterable<T>
 *
 * In Electron, `window.electronAPI.api.*` is the source of truth — every
 * call goes over IPC (zero HTTP), and streams arrive on a MessagePort.
 * In the browser dev server (vite dev), the same calls fall back to
 * fetch against the Hono routes / EventSource against SSE endpoints.
 *
 * This file replaces `useApi(url)` for new code — existing useApi
 * callsites keep working unchanged so the migration is incremental.
 */

import type { Api } from '@mcp/api-bus';
import { getCached, dedupe, dedupeInflight, invalidateAll } from './api-cache.js';
import {
  recordApiCallCacheHit,
  startApiCallRouteSpan,
} from './perf/route-startup-metrics.js';
import { gitOperationKey, useGitOperationState } from '../state/git-operation-state.js';

type DotPath = string;
export interface ApiCallOptions { signal?: AbortSignal }
let cancellableInvokeSeq = 0;

/**
 * Idempotent read verbs whose result is safe to dedup + briefly cache so
 * co-mounted consumers (e.g. StatusBar + GitWindow both reading git status,
 * or multiple panels reading projects.get) collapse to ONE IPC round-trip.
 * Deliberately excludes `files.tree`/`files.list` (the live file-tree store
 * applies incremental fs-events; a re-read must reflect them) and per-
 * keystroke reads (`lsp.completion`/`search.*`).
 */
const READ_VERBS = new Set<string>([
  'projects.get',
  'projects.stats',
  'projects.list',
  'plugins.activeContributions',
  // Plugin assets are immutable for an installed version — the backend also
  // keeps a longer-lived LRU keyed by mtime; this collapses co-mounted reads.
  'plugins.readAsset',
  'snapshots.list',
  'lsp.listServers',
  'lsp.instances',
  'lsp.languageLevels',
]);

/**
 * Live reads that must reflect the latest backend state on every settle, so
 * they can NOT be TTL-cached — but a BURST of identical concurrent calls (tab
 * restore firing N reads of the same path, two components expanding the same
 * dir, chip + install-prompt both polling one server's status) should still
 * collapse to one round-trip. They share an in-flight promise only
 * (`dedupeInflight`), never a cached body.
 *
 * `lsp.serverStatus` belongs here, NOT in READ_VERBS: the install prompt may
 * poll it while a lightweight server transitions `idle → starting → ready`,
 * and a TTL cache would serve a stale snapshot for roughly half the polls.
 */
const INFLIGHT_VERBS = new Set<string>([
  'files.read',
  'files.tree',
  'files.list',
  // Project-open surfaces (toolbar, LSP prompt, gutter) mount together and
  // ask the same filesystem-backed questions. Share only the live promise;
  // after it settles, manifest/file changes are observed normally.
  'runner.detect',
  'runner.fileRunTarget',
  'editor.resolveConfig',
  'lsp.serverStatus',
  // Git freshness is revision-driven. Share concurrent reads, but never reuse a
  // timed body after an external checkout/index/worktree change.
  'projectGit.status',
  'projectGit.statusPage',
  'projectGit.log',
  'projectGit.logPage',
  'projectGit.mergeState',
  'projectGit.branchesDetailed',
  'projectGit.stashList',
  'projectGit.commitDetail',
  'projectGit.stashDetail',
  'projectGit.gitOptimizations',
]);

/**
 * Canonicalize a read verb's input BEFORE keying/caching so callers that
 * differ only cosmetically collapse to one slot. Git inputs are preserved:
 * the backend now has a true one-process summary and a progressive full
 * snapshot, so silently upgrading one into the other would waste work.
 */
function normalizeReadInput(_path: DotPath, input: unknown): unknown {
  return input;
}

/**
 * Mutating verbs that change a resource a READ_VERB reads. On success they
 * flush the short-TTL read cache so the next read revalidates (same
 * flush-all policy as the HTTP mutation helpers in hooks/useApi.ts).
 */
const WRITE_VERBS = new Set<string>([
  'files.write',
  'files.delete',
  'files.rename',
  'files.mkdir',
  'files.historyRestore',
  'snapshots.create',
  'snapshots.update',
  'snapshots.delete',
  'projectGit.stage',
  'projectGit.unstage',
  'projectGit.discard',
  'projectGit.commit',
  'projectGit.stageHunk',
  'projectGit.configureGitOptimizations',
  'projectGit.branchCheckout',
  'projectGit.branchCreate',
  'projectGit.branchDelete',
  'projectGit.branchRename',
  'projectGit.merge',
  'projectGit.rebase',
  'projectGit.reset',
  'projectGit.revert',
  'projectGit.cherryPick',
  'projectGit.resolveConflict',
  'projectGit.mergeContinue',
  'projectGit.mergeAbort',
  'projectGit.push',
  'projectGit.fetch',
  'projectGit.pull',
  'projectGit.updateBranch',
  'projectGit.stashSave',
  'projectGit.stashPop',
  'projectGit.stashApply',
  'projectGit.stashDrop',
  'projectGit.aiExecute',
  'lsp.removeServer',
  'lsp.restartServer',
  'lsp.setLanguageLevel',
]);

/** Stable cache key for a read verb + its args. */
function callKey(path: DotPath, input: unknown): string {
  return `CALL ${path} ${input === undefined ? '' : JSON.stringify(input)}`;
}

/**
 * Base URL for HTTP fetches against the backend.
 *
 * Inside Electron: prefix with `mcp://app` so the request rides the
 * custom protocol handler we registered in the main process — same
 * Hono routes, but dispatched in-process via `app.fetch(Request)`,
 * NO socket, NO loopback. The Hono dev HTTP listener stays off by
 * default (MCP_DEV_HTTP=0).
 *
 * In browser dev (vite dev): empty base so relative URLs route through
 * the Vite proxy → Hono listener (operator runs `MCP_DEV_HTTP=1`).
 *
 * Detection: `navigator.userAgent` contains "Electron" in the desktop
 * shell. We DON'T rely on `window.electronAPI` here — the preload that
 * exposes that field can fail or load late, and we still want the URL
 * to point at the mcp:// scheme (which the main process registers
 * unconditionally). Mirrors install-fetch-base's logic.
 *
 * Override at runtime via `window.__MCP_API_BASE__` for tunnels /
 * remote backends.
 */
export function apiBaseUrl(): string {
  if (typeof window === 'undefined') return '';
  const override = (window as unknown as { __MCP_API_BASE__?: string }).__MCP_API_BASE__;
  if (typeof override === 'string') return override;
  if (isElectronRenderer()) return 'mcp://app';
  return '';
}

/**
 * Detect the Electron desktop shell.
 *
 * The UA check is the primary signal, BUT after the Electron 42 upgrade some
 * renderers no longer carry "Electron/" in `navigator.userAgent` — so the
 * UA-only check returned false INSIDE the app, `apiBaseUrl()` fell back to ''
 * (relative), and `/api/*` hit the http loopback / Vite proxy (7317→7333)
 * instead of the in-process `mcp://app` backend where company orchestrators
 * live → `/answer` 404'd with "No active orchestrator".
 *
 * The reliable fallback is the preload-exposed `electronAPI.invoke` primitive:
 * a plain function that crosses `contextBridge` (Proxies don't — see
 * `electronInvoke`) and is present in EVERY app window. A browser never has it,
 * so there are no false positives. Shared by the fetch interceptor
 * (install-fetch-base.ts) so the two transports never disagree.
 */
export function isElectronRenderer(): boolean {
  if (typeof window === 'undefined') return false;
  if (typeof navigator !== 'undefined' && /\bElectron\//i.test(navigator.userAgent)) return true;
  const electron = (window as unknown as { electronAPI?: { invoke?: unknown } }).electronAPI;
  return !!electron && typeof electron.invoke === 'function';
}

/**
 * Detect Electron via the contextBridge primitive. Previously we walked
 * `window.electronAPI.api.foo.bar` to resolve a method — that relied on
 * a Proxy surviving contextBridge, which it does NOT (Electron serialises
 * exposed objects and Proxies have no own enumerable properties to walk).
 * Effect: every IPC call silently fell through to `dottedToHttp`, and any
 * method without an HTTP mapping (e.g. `terminal.spawn`) threw.
 *
 * Now we just check whether the primitive `invoke` is present — that's
 * exposed as a plain function in preload, which DOES cross the bridge.
 */
function electronInvoke(): ((methodPath: string, payload: unknown, requestId?: string) => Promise<unknown>) | null {
  const electron = typeof window !== 'undefined' ? window.electronAPI : undefined;
  if (!electron || typeof electron.invoke !== 'function') return null;
  return electron.invoke.bind(electron);
}

function electronCancelInvoke(): ((requestId: string) => void) | null {
  const electron = typeof window !== 'undefined' ? window.electronAPI : undefined;
  return electron?.cancelInvoke?.bind(electron) ?? null;
}

function abortError(): Error {
  const error = new Error('request cancelled');
  error.name = 'AbortError';
  return error;
}

function nextInvokeId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `renderer-${Date.now()}-${++cancellableInvokeSeq}`;
}

function electronOpenStream(): (<T>(methodPath: string, payload: unknown) => AsyncIterable<T>) | null {
  const electron = typeof window !== 'undefined' ? window.electronAPI : undefined;
  if (!electron || typeof electron.openStream !== 'function') return null;
  return electron.openStream.bind(electron) as <T>(p: string, payload: unknown) => AsyncIterable<T>;
}

/**
 * Map a dotted method path to a Hono REST endpoint (best-effort, used
 * only in the browser fallback). Coverage is the IDE-hot subset; less
 * common methods fall through to a thrown error so we don't silently
 * shadow a missing implementation.
 */
function dottedToHttp(path: DotPath, input: unknown): { url: string; init: RequestInit } | null {
  const json = (b: unknown): RequestInit => ({
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(b),
  });
  const ip = input as Record<string, unknown> | undefined;
  if (path.startsWith('projectGit.') && ip?.projectId) {
    const method = path.slice('projectGit.'.length);
    return {
      url: `/api/projects/${ip.projectId}/git/rpc/${encodeURIComponent(method)}`,
      init: json(ip),
    };
  }
  switch (path) {
    case 'projects.list':
      return { url: '/api/projects', init: {} };
    case 'projects.get':
      return { url: `/api/projects/${ip!.id}`, init: {} };
    case 'projects.activate':
      return { url: `/api/projects/${ip!.id}/activation`, init: json({ activationId: ip!.activationId, clientId: ip!.clientId }) };
    case 'projects.deactivate':
      return {
        url: `/api/projects/${ip!.id}/activation`,
        init: { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ activationId: ip!.activationId, clientId: ip!.clientId }) },
      };
    case 'projects.stats':
      return { url: `/api/projects/${ip!.id}/stats`, init: {} };
    case 'files.list':
      return { url: `/api/projects/${ip!.projectId}/files`, init: {} };
    case 'files.tree': {
      const depth = ip!.maxDepth != null ? `&maxDepth=${Number(ip!.maxDepth)}` : '';
      const stats = (ip as { withStats?: boolean }).withStats ? '&withStats=1' : '';
      return { url: `/api/projects/${ip!.projectId}/file-tree?root=${encodeURIComponent(String(ip!.root ?? '.'))}${depth}${stats}`, init: {} };
    }
    case 'files.read': {
      const ims = ip!.ifModifiedSince ? `&ifModifiedSince=${encodeURIComponent(String(ip!.ifModifiedSince))}` : '';
      return { url: `/api/projects/${ip!.projectId}/file?path=${encodeURIComponent(String(ip!.path))}${ims}`, init: {} };
    }
    case 'files.write':
      return { url: `/api/projects/${ip!.projectId}/file`, init: { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: ip!.path, content: ip!.content, encoding: (ip as { encoding?: string }).encoding }) } };
    case 'files.delete':
      return {
        url: `/api/projects/${ip!.projectId}/file?path=${encodeURIComponent(String(ip!.path))}${ip!.recursive ? '&recursive=1' : ''}`,
        init: { method: 'DELETE' },
      };
    case 'files.rename':
      return {
        url: `/api/projects/${ip!.projectId}/file/rename`,
        init: json({ from: ip!.from, to: ip!.to }),
      };
    case 'files.mkdir':
      return {
        url: `/api/projects/${ip!.projectId}/dir`,
        init: json({ path: ip!.path }),
      };
    case 'files.historyList':
      return { url: `/api/projects/${ip!.projectId}/file/history?path=${encodeURIComponent(String(ip!.path))}`, init: {} };
    case 'files.historyGet':
      return { url: `/api/projects/${ip!.projectId}/file/history/${Number(ip!.id)}`, init: {} };
    case 'files.historyRestore':
      return { url: `/api/projects/${ip!.projectId}/file/history/${Number(ip!.id)}/restore`, init: { method: 'POST' } };
    case 'files.historyLabel':
      return { url: `/api/projects/${ip!.projectId}/file/history/${Number(ip!.id)}/label`, init: json({ label: ip!.label }) };
    case 'snapshots.list':
      return {
        url: `/api/projects/${ip!.projectId}/snapshots${ip!.category ? `?category=${encodeURIComponent(String(ip!.category))}` : ''}`,
        init: {},
      };
    case 'snapshots.create':
      return {
        url: `/api/projects/${ip!.projectId}/snapshots`,
        init: json({
          title: ip!.title,
          category: ip!.category,
          content: ip!.content,
          tags: ip!.tags,
        }),
      };
    case 'snapshots.update':
      return {
        url: `/api/snapshots/${ip!.id}`,
        init: {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title: ip!.title,
            category: ip!.category,
            content: ip!.content,
            tags: ip!.tags,
          }),
        },
      };
    case 'snapshots.delete':
      return {
        url: `/api/snapshots/${ip!.id}`,
        init: { method: 'DELETE' },
      };
    case 'projectGit.status':
      return {
        url: `/api/projects/${ip!.projectId}/git/status${ip!.includeFiles === false ? '?includeFiles=0' : ''}`,
        init: {},
      };
    case 'projectGit.diff':
      return {
        url: `/api/projects/${ip!.projectId}/git/diff`,
        init: json({ path: ip!.path, staged: ip!.staged }),
      };
    case 'projectGit.log':
      return {
        url: `/api/projects/${ip!.projectId}/git/log?limit=${ip!.limit ?? 30}${ip!.skip ? `&skip=${ip!.skip}` : ''}${ip!.path ? `&path=${encodeURIComponent(String(ip!.path))}` : ''}${ip!.branch ? `&branch=${encodeURIComponent(String(ip!.branch))}` : ''}${ip!.all ? '&all=true' : ''}`,
        init: {},
      };
    case 'projectGit.stage':
      return {
        url: `/api/projects/${ip!.projectId}/git/stage`,
        init: json({ paths: ip!.paths }),
      };
    case 'projectGit.unstage':
      return {
        url: `/api/projects/${ip!.projectId}/git/unstage`,
        init: json({ paths: ip!.paths }),
      };
    case 'projectGit.discard':
      return {
        url: `/api/projects/${ip!.projectId}/git/discard`,
        init: json({ paths: ip!.paths }),
      };
    case 'projectGit.commit':
      return {
        url: `/api/projects/${ip!.projectId}/git/commit`,
        init: json({ message: ip!.message, amend: ip!.amend }),
      };
    case 'lsp.completion':
    case 'lsp.hover':
    case 'lsp.definition':
    case 'lsp.references':
    case 'lsp.implementation':
    case 'lsp.diagnostics': {
      const op = path.split('.')[1];
      return {
        url: `/api/lsp/${ip!.projectId}/${op}`,
        init: json({ file: ip!.file, position: ip!.position, content: ip!.content, context: ip!.context }),
      };
    }
    case 'lsp.formatting':
      return {
        url: `/api/lsp/${ip!.projectId}/formatting`,
        init: json({ file: ip!.file, range: ip!.range, options: ip!.options }),
      };
    case 'lsp.organizeImports':
      return { url: `/api/lsp/${ip!.projectId}/organize-imports`, init: json({ file: ip!.file }) };
    case 'lsp.codeActions':
      return { url: `/api/lsp/${ip!.projectId}/code-actions`, init: json({ file: ip!.file, range: ip!.range }) };
    case 'lsp.rename':
      return { url: `/api/lsp/${ip!.projectId}/rename`, init: json({ file: ip!.file, position: ip!.position, newName: ip!.newName }) };
    case 'lsp.signatureHelp':
      return { url: `/api/lsp/${ip!.projectId}/signature-help`, init: json({ file: ip!.file, position: ip!.position }) };
    case 'lsp.documentSymbols':
      return { url: `/api/lsp/${ip!.projectId}/document-symbols`, init: json({ file: ip!.file }) };
    case 'lsp.didOpen':
      return {
        url: `/api/lsp/${ip!.projectId}/did-open`,
        init: json({ file: ip!.file, languageId: ip!.languageId, version: ip!.version, content: ip!.content, syncSessionId: ip!.syncSessionId }),
      };
    case 'lsp.didChange':
      return {
        url: `/api/lsp/${ip!.projectId}/did-change`,
        init: json({ file: ip!.file, version: ip!.version, changes: ip!.changes, syncSessionId: ip!.syncSessionId }),
      };
    case 'lsp.didClose':
      return { url: `/api/lsp/${ip!.projectId}/did-close`, init: json({ file: ip!.file, syncSessionId: ip!.syncSessionId }) };
    case 'lsp.resolveCompletion':
      return { url: `/api/lsp/${ip!.projectId}/resolve-completion`, init: json({ file: ip!.file, item: ip!.item }) };
    case 'lsp.resolveCodeAction':
      return { url: `/api/lsp/${ip!.projectId}/resolve-code-action`, init: json({ file: ip!.file, action: ip!.action }) };
    case 'lsp.executeCodeAction':
      return { url: `/api/lsp/${ip!.projectId}/execute-code-action`, init: json({ action: ip!.action }) };
    case 'lsp.serverStatus':
      return { url: `/api/lsp/${ip!.projectId}/server-status`, init: json({ languageId: ip!.languageId }) };
    case 'lsp.listServers':
      return { url: '/api/lsp/servers', init: { method: 'GET' } };
    case 'lsp.instances':
      return { url: '/api/lsp/instances', init: { method: 'GET' } };
    case 'editor.complete':
      return { url: '/api/editor/complete', init: json(ip!) };
    case 'editor.resolveConfig':
      return { url: '/api/editor/resolve-config', init: json(ip!) };
    case 'editor.cancel':
      return { url: '/api/editor/cancel', init: json(ip!) };
    case 'editor.probe':
      return { url: '/api/editor/probe', init: json(ip ?? {}) };
    case 'editor.feedback':
      return { url: '/api/editor/feedback', init: json(ip!) };
    case 'editor.delivery':
      return { url: '/api/editor/delivery', init: json(ip!) };
    case 'editor.stats':
      return { url: '/api/editor/stats', init: json(ip ?? {}) };
    case 'search.project': {
      const qp = new URLSearchParams({ q: String(ip!.query), limit: String(Number(ip!.limit ?? 50)) });
      if (ip!.mode) qp.set('mode', String(ip!.mode));
      if (ip!.type) qp.set('type', String(ip!.type));
      return { url: `/api/projects/${ip!.projectId}/search?${qp.toString()}`, init: {} };
    }
    case 'search.grep':
      return { url: `/api/projects/${ip!.projectId}/search/grep`, init: json(ip!) };
    case 'search.replace':
      return { url: `/api/projects/${ip!.projectId}/search/replace`, init: json(ip!) };
    case 'search.symbols':
      return { url: `/api/projects/${ip!.projectId}/search/symbols?q=${encodeURIComponent(String(ip!.query))}&limit=${Number(ip!.limit ?? 50)}`, init: {} };
    case 'search.text':
      return { url: `/api/projects/${ip!.projectId}/search/text?q=${encodeURIComponent(String(ip!.query))}&limit=${Number(ip!.limit ?? 50)}`, init: {} };
    case 'lsp.removeServer':
      return { url: `/api/lsp/servers/${ip!.serverId}`, init: { method: 'DELETE' } };
    case 'lsp.restartServer':
      return { url: `/api/lsp/${ip!.projectId}/servers/${ip!.serverId}/restart`, init: json({}) };
    case 'lsp.setLanguageLevel':
      return { url: `/api/lsp/${ip!.projectId}/language-level`, init: json({ languageId: ip!.languageId, level: ip!.level }) };
    case 'lsp.languageLevels':
      return { url: `/api/lsp/${ip!.projectId}/language-levels`, init: {} };
    default:
      return null;
  }
}

/**
 * One-shot RPC call. Prefers Electron IPC (full coverage of api-bus);
 * falls back to HTTP via `dottedToHttp` for the browser-dev path only.
 *
 * Front door: idempotent reads (READ_VERBS) go through the shared in-flight
 * dedup + short-TTL cache (collapses co-mounted identical reads into one
 * round-trip); writes (WRITE_VERBS) flush that cache on success; everything
 * else passes straight through.
 */
export function apiCall<T>(path: DotPath, input?: unknown, options: ApiCallOptions = {}): Promise<T> {
  // Cancellable calls cannot share a cached/in-flight promise: one Monaco
  // token must never abort another consumer that happens to use the same key.
  if (options.signal) return apiCallRaw<T>(path, input, options);
  if (READ_VERBS.has(path)) {
    const normalized = normalizeReadInput(path, input);
    const key = callKey(path, normalized);
    const hit = getCached<T>(key);
    if (hit !== undefined) {
      recordApiCallCacheHit(path, normalized);
      return Promise.resolve(hit);
    }
    return dedupe<T>(key, () => apiCallRaw<T>(path, normalized));
  }
  if (INFLIGHT_VERBS.has(path)) {
    return dedupeInflight<T>(callKey(path, input), () => apiCallRaw<T>(path, input));
  }
  if (WRITE_VERBS.has(path)) {
    const value = input as { projectId?: number; repoPath?: string } | undefined;
    const operationKey = path.startsWith('projectGit.') && value?.projectId
      ? gitOperationKey(value.projectId, value.repoPath)
      : null;
    if (operationKey) useGitOperationState.getState().begin(operationKey);
    return apiCallRaw<T>(path, input)
      .then((r) => {
        invalidateAll();
        return r;
      })
      .finally(() => {
        if (operationKey) useGitOperationState.getState().end(operationKey);
      });
  }
  return apiCallRaw<T>(path, input);
}

async function apiCallRaw<T>(path: DotPath, input?: unknown, options: ApiCallOptions = {}): Promise<T> {
  const finishSpan = startApiCallRouteSpan(path, input);
  try {
    if (options.signal?.aborted) throw abortError();
    const invoke = electronInvoke();
    if (invoke) {
      const requestId = options.signal ? nextInvokeId() : undefined;
      const pending = invoke(path, input, requestId);
      const wrapped = (await (options.signal && requestId
        ? new Promise<unknown>((resolve, reject) => {
            const onAbort = () => {
              electronCancelInvoke()?.(requestId);
              reject(abortError());
            };
            options.signal!.addEventListener('abort', onAbort, { once: true });
            // The signal can flip after the preflight above but before the
            // listener is attached. AbortSignal does not replay past events,
            // so close that narrow race explicitly.
            if (options.signal!.aborted) onAbort();
            pending.then(resolve, reject).finally(() => {
              options.signal!.removeEventListener('abort', onAbort);
            });
          })
        : pending)) as {
        ok: boolean;
        value?: T;
        error?: { message: string; code?: string; status?: number; details?: Record<string, unknown> };
      };
      if (!wrapped.ok) {
        const err = wrapped.error ?? { message: 'unknown ipc error' };
        const e = new Error(err.message) as Error & { code?: string; status?: number; details?: Record<string, unknown> };
        if (err.code) e.code = err.code;
        if (err.status) e.status = err.status;
        // Preserve structured metadata (e.g. SSH host-key fingerprint) for callers that branch on it.
        if (err.details) e.details = err.details;
        throw e;
      }
      finishSpan({ status: 'ok' });
      return wrapped.value as T;
    }
    // HTTP fallback (browser dev only — Electron always has `invoke`).
    const mapped = dottedToHttp(path, input);
    if (!mapped) {
      throw new Error(`apiCall("${path}"): no HTTP fallback mapped — this method is Electron-only or needs a mapping entry`);
    }
    const res = await fetch(mapped.url, { ...mapped.init, signal: options.signal });
    if (!res.ok) {
      const body = await res.json().catch(() => null) as { error?: string; code?: string; message?: string } | null;
      const e = new Error(body?.message ?? body?.error ?? `HTTP ${res.status} on ${path}`) as Error & { code?: string; status?: number };
      e.status = res.status;
      e.code = body?.code ?? body?.error;
      throw e;
    }
    // Some routes return text (e.g. snapshots.getForContext); detect by header.
    const ct = res.headers.get('content-type') ?? '';
    const value = ct.includes('application/json')
      ? ((await res.json()) as T)
      : ((await res.text()) as unknown as T);
    finishSpan({ status: 'ok' });
    return value;
  } catch (err) {
    finishSpan({ status: 'error', error: errorMessage(err) });
    throw err;
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Streaming RPC call. Electron returns an AsyncIterable backed by a
 * MessagePort; the browser fallback wraps EventSource into an iterable
 * with the same surface. Both end naturally when the producer closes.
 */
export function apiStream<T>(path: DotPath, input?: unknown): AsyncIterable<T> {
  const stream = electronOpenStream();
  if (stream) {
    return stream<T>(path, input);
  }
  // Browser fallback — only the streams we explicitly handle today.
  // Returns an iterable that throws on first iteration if unmapped, so
  // callers don't get silent empties.
  return {
    [Symbol.asyncIterator](): AsyncIterator<T> {
      return {
        async next() {
          throw new Error(
            `apiStream("${path}"): browser SSE fallback not wired yet — open the app in Electron or add a mapping`,
          );
        },
      };
    },
  };
}

/**
 * Quick boolean: are we in Electron with the IPC primitives wired?
 *
 * Replaces the old `electronApi()` helper that returned the (now-gone)
 * Proxy object — `electronAPI.api` no longer exists since the Proxy
 * approach didn't survive contextBridge. Callers that want the full
 * type surface should use the `Api` type from `@mcp/api-bus` plus
 * `apiCall(path, input)` for typed dispatch.
 *
 * Returns truthy in any Electron renderer where the preload loaded
 * successfully; null when running in a browser dev tab or if the
 * preload bridge failed to expose primitives.
 */
export function electronApi(): { invoke: ElectronAPI['invoke']; openStream: ElectronAPI['openStream'] } | null {
  if (typeof window === 'undefined') return null;
  const electron = window.electronAPI;
  if (!electron || typeof electron.invoke !== 'function') return null;
  return {
    invoke: electron.invoke.bind(electron),
    openStream: electron.openStream.bind(electron),
  };
}
