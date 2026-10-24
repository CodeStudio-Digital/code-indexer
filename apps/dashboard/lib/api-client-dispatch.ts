import { getCached, dedupe, dedupeInflight, invalidateAll } from './api-cache.js';
import { recordApiCallCacheHit, startApiCallRouteSpan } from './perf/route-startup-metrics.js';
import { gitOperationKey, useGitOperationState } from '../state/git-operation-state.js';
import { beginExecution, finishExecution } from '../state/execution-output.js';
import { useWorkspaceLayout } from '../state/workspace-layout.js';
import { type DotPath, type ApiCallOptions, abortError, electronInvoke, nextInvokeId, electronCancelInvoke, electronOpenStream } from './api-client-transport.js';
import { gitOperationLabel, gitCommand, formatGitExecution, withTerminalEol } from './api-client-git-output.js';
import { dottedToHttp } from './api-client-http-routes.js';

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
  'lsp.angularProfileOverrides',
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
  'files.searchPaths',
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
  'projectGit.createPullRequest',
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
  'lsp.setAngularProfileOverride',
]);

/** Stable cache key for a read verb + its args. */
function callKey(path: DotPath, input: unknown): string {
  return `CALL ${path} ${input === undefined ? '' : JSON.stringify(input)}`;
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
    const executionId = path.startsWith('projectGit.') && value?.projectId
      ? beginExecution({
          projectId: value.projectId,
          source: 'git',
          label: gitOperationLabel(path),
          command: gitCommand(path),
          status: 'running',
          output: `$ ${gitCommand(path)}\r\n`,
        })
      : null;
    if (operationKey) useGitOperationState.getState().begin(operationKey);
    return apiCallRaw<T>(path, input)
      .then((r) => {
        invalidateAll();
        if (executionId) {
          const completed = formatGitExecution(path, r);
          finishExecution(executionId, completed);
          if (completed.status === 'failed') useWorkspaceLayout.getState().setActiveBottom('output');
        }
        return r;
      })
      .catch((error) => {
        if (executionId) {
          const command = gitCommand(path);
          finishExecution(executionId, {
            status: 'failed',
            command,
            output: `$ ${command}\r\n${withTerminalEol(errorMessage(error))}`,
          });
          useWorkspaceLayout.getState().setActiveBottom('output');
        }
        throw error;
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
