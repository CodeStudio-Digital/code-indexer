/**
 * Handlers for the `projects` namespace. Pure functions over the shared
 * `HandlerDeps`; no Hono, no Electron. The legacy Hono routes in
 * apps/http-api/server/routes/projects.ts now delegate here.
 */

import { ApiError, type ApiContext, type AsyncStream, type ProjectsApi, type ProjectIndexStatus, type FsEventsFrame, type GitMetaFrame, type IndexStreamEvent, type ScaffoldStreamEvent } from '@mcp/api-bus';
import { runScaffoldStream } from './scaffold.js';
import { detectProjectFramework } from './detect-framework.js';
import {
  CreateProjectService,
  UpdateProjectService,
  IndexProjectUseCase,
  ProjectError,
  type CreateProjectInput,
  type UpdateProjectInput,
  type IndexProjectInput,
} from '@mcp/services/services/projects/index.js';
import { makeHybridSearchCacheInvalidator } from '@mcp/indexer/search/cache-invalidator.js';
import {
  composeFilesUpdatedListeners,
  makeAutoDiscoveryIndexListener,
} from '@mcp/services/services/docs/index.js';
import { codeNamespace } from '@mcp/shared/vector-namespace.js';
import { clearProjectEdits } from '../editor/completion/snippets/edit-tracker.js';
import type { HandlerDeps } from '../types.js';

/**
 * Translate a domain `ProjectError` to the structured `ApiError` the
 * transport layer maps to an HTTP/IPC error payload. Keeps the handlers
 * agnostic of whether the caller is HTTP or IPC.
 */
function wrap<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof ProjectError) {
      throw new ApiError(err.message, err.statusCode);
    }
    throw err;
  }
}

async function wrapAsync<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ProjectError) {
      throw new ApiError(err.message, err.statusCode);
    }
    throw err;
  }
}

export function createProjectsHandlers(deps: HandlerDeps): ProjectsApi {
  const { db, vectorStore } = deps;

  const createService = new CreateProjectService(db);
  const updateService = new UpdateProjectService(db);
  const indexUseCase = new IndexProjectUseCase({
    db,
    providerStore: deps.providerStore,
    embeddingService: deps.embeddingService,
    vectorStore: deps.vectorStore,
    costTracker: deps.costTracker,
    webhookDispatcher: deps.webhookDispatcher,
    config: deps.config,
    lshIndexingSink: deps.lshIndexingSink,
    // I3 — invalidate HybridSearch query LRU after each re-index. Listener
    // throws are swallowed inside IndexAgent; absent search instance is
    // tolerated by makeHybridSearchCacheInvalidator. Safe to wire
    // unconditionally — the listener no-ops when nothing is cached.
    // Composed with the doc auto-discovery scan (fire-and-forget + 6h
    // per-project debounce inside the listener — it never holds the run).
    filesUpdatedListener: composeFilesUpdatedListeners(
      deps.hybridSearch ? makeHybridSearchCacheInvalidator(deps.hybridSearch) : undefined,
      makeAutoDiscoveryIndexListener({
        db: db.raw(),
        getProjectRoot: (projectId) => db.getProject(projectId)?.root_path ?? null,
      }),
    ),
  });

  // Clear a project's REMOTE vectors. Prefers a wholesale namespace drop
  // (sqlite-vec / Qdrant / Pinecone); falls back to per-id snapshot delete on
  // Cloudflare Vectorize (no delete-by-metadata). Shared by delete + clearAllData.
  async function clearProjectVectors(
    project: { id: number; name: string },
  ): Promise<{ known: number; deleted: number; error: string | null }> {
    const vectorIds = db.snapshotVectorIdsForProject(project.id);
    let deleted = 0;
    let error: string | null = null;
    if (typeof vectorStore.deleteNamespace === 'function') {
      try {
        deleted = await vectorStore.deleteNamespace(codeNamespace(project.name));
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
      }
    } else if (vectorIds.length > 0) {
      try {
        deleted = await vectorStore.deleteByIds(vectorIds);
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
        db.enqueuePendingVectorDeletes(
          vectorIds.map((vid) => ({ vector_id: vid, project_name: project.name, error: error! })),
        );
      }
    }
    return { known: vectorIds.length, deleted, error };
  }

  // Serialize manual index runs against the structural service (auto run ×
  // watcher drain × full index share one per-project mutex) and surface the
  // semantic_indexing phase to status subscribers. Structural-mode manual
  // runs take the bare lock — they must not flip the phase to semantic.
  function lockedIndexRun<T>(id: number, input: IndexProjectInput, fn: () => Promise<T>): Promise<T> {
    return input.mode === 'structural'
      ? deps.projectIndexService.withProjectLock(id, fn)
      : deps.projectIndexService.withSemanticRun(id, fn);
  }

  return {
    async list(_input, _ctx: ApiContext) {
      return db.listProjects();
    },

    async listForGlobalPicker(_input, _ctx: ApiContext) {
      return db.listProjectsForGlobalPicker();
    },

    async get({ id }) {
      const project = db.getProject(id);
      if (!project) throw new ApiError('not_found', 404, 'project not found');
      // "Project opened" — the ProjectView mount lands here in both
      // transports (HTTP + Electron IPC). Fire-and-forget: memory-only
      // checks inside; never delays the GET.
      deps.projectIndexService.ensureFresh(id, 'open');
      // Cheap package.json read — classifies the framework so the preview pane
      // can auto-pick the React-native element picker over the universal one.
      return { ...project, framework: detectProjectFramework(project.root_path) };
    },

    async create(input) {
      return wrap(() => createService.execute(input as CreateProjectInput));
    },

    async update({ id, ...patch }) {
      const result = wrap(() => updateService.execute(id, patch as UpdateProjectInput));
      if (!result) throw new ApiError('not_found', 404, 'project not found');
      if (Object.prototype.hasOwnProperty.call(patch, 'index_ignore_patterns')) {
        deps.projectIndexService.restartFileWatching(id);
      }
      return result;
    },

    async delete({ id }) {
      const project = db.getProject(id);
      if (!project) throw new ApiError('not_found', 404, 'project not found');

      await deps.projectIndexService.stopWatching(id).catch(() => undefined);
      clearProjectEdits(id); // completion edit-tracker: drop the project's ring
      const v = await clearProjectVectors(project);
      db.deleteProject(id);
      return {
        ok: true as const,
        vectors_known: v.known,
        vectors_deleted_remote: v.deleted,
        remote_error: v.error,
      };
    },

    async clearData({ id }) {
      const project = db.getProject(id);
      if (!project) throw new ApiError('not_found', 404, 'project not found');
      const v = await clearProjectVectors(project);
      db.clearProjectData(id);
      deps.hybridSearch?.invalidateCache?.();
      return {
        ok: true as const,
        vectors_known: v.known,
        vectors_deleted_remote: v.deleted,
        remote_error: v.error,
      };
    },

    async clearAllData() {
      // Wipe every project's data (index, sessions, snapshots, runs, costs) +
      // its remote vectors, but KEEP each project row so the user only has to
      // re-index — not re-create. Errors per project are collected, not fatal.
      const all = db.listProjects();
      let projectsCleared = 0;
      let vectorsDeleted = 0;
      const errors: Array<{ project: string; error: string }> = [];
      for (const project of all) {
        const v = await clearProjectVectors(project);
        if (v.error) errors.push({ project: project.name, error: v.error });
        vectorsDeleted += v.deleted;
        db.clearProjectData(project.id);
        projectsCleared++;
      }
      // Drop the in-memory search caches so stale results don't linger.
      deps.hybridSearch?.invalidateCache?.();
      return {
        ok: true as const,
        projects_cleared: projectsCleared,
        vectors_deleted_remote: vectorsDeleted,
        errors,
      };
    },

    async stats({ id }) {
      // The legacy route lives in stats.ts but it's keyed by projectId,
      // so it naturally belongs to ProjectsApi. Mirrors GET /api/projects/:id/stats.
      return db.getStats(id);
    },

    async indexStatus({ id }) {
      if (!db.getProject(id)) throw new ApiError('not_found', 404, 'project not found');
      return deps.projectIndexService.getStatus(id);
    },

    fsEventsStream({ id }): AsyncStream<FsEventsFrame> {
      if (!db.getProject(id)) throw new ApiError('not_found', 404, 'project not found');
      const svc = deps.projectIndexService;
      // Same hand-rolled iterator rationale as indexStatusStream: an
      // indefinite stream must unsubscribe on return(). Frames coalesce
      // events for ~200ms so checkout bursts arrive as one batch.
      return {
        [Symbol.asyncIterator](): AsyncIterator<FsEventsFrame> {
          const queue: FsEventsFrame[] = [];
          let waiter: ((r: IteratorResult<FsEventsFrame>) => void) | null = null;
          let pending: FsEventsFrame['events'] = [];
          let timer: ReturnType<typeof setTimeout> | null = null;
          let closed = false;
          const push = (frame: FsEventsFrame) => {
            if (closed) return;
            if (waiter) { const w = waiter; waiter = null; w({ value: frame, done: false }); }
            else queue.push(frame);
          };
          const unsub = svc.subscribeFsEvents(id, (events) => {
            pending.push(...events);
            if (timer) return;
            timer = setTimeout(() => {
              timer = null;
              if (pending.length > 0) { const events = pending; pending = []; push({ events }); }
            }, 200);
          });
          const cleanup = () => {
            if (closed) return;
            closed = true;
            unsub();
            if (timer) clearTimeout(timer);
            if (waiter) { const w = waiter; waiter = null; w({ value: undefined as never, done: true }); }
          };
          return {
            async next(): Promise<IteratorResult<FsEventsFrame>> {
              if (queue.length > 0) return { value: queue.shift()!, done: false };
              if (closed) return { value: undefined as never, done: true };
              return new Promise((resolve) => { waiter = resolve; });
            },
            async return(): Promise<IteratorResult<FsEventsFrame>> {
              cleanup();
              return { value: undefined as never, done: true };
            },
            async throw(e?: unknown): Promise<IteratorResult<FsEventsFrame>> {
              cleanup();
              throw e;
            },
          };
        },
      };
    },

    gitMetaStream({ id }): AsyncStream<GitMetaFrame> {
      if (!db.getProject(id)) throw new ApiError('not_found', 404, 'project not found');
      const svc = deps.projectIndexService;
      // Indefinite stream → must unsubscribe on return(). The watcher already
      // coalesces a checkout burst (~250ms) into one event, so we forward each
      // event straight through as a frame (no extra coalescing here).
      return {
        [Symbol.asyncIterator](): AsyncIterator<GitMetaFrame> {
          const queue: GitMetaFrame[] = [];
          let waiter: ((r: IteratorResult<GitMetaFrame>) => void) | null = null;
          let closed = false;
          const push = (frame: GitMetaFrame) => {
            if (closed) return;
            if (waiter) { const w = waiter; waiter = null; w({ value: frame, done: false }); }
            else queue.push(frame);
          };
          const unsub = svc.subscribeGitMeta(id, (event) => {
            push({ branch: event.branch, detached: event.detached, changed: event.changed });
          });
          const cleanup = () => {
            if (closed) return;
            closed = true;
            unsub();
            if (waiter) { const w = waiter; waiter = null; w({ value: undefined as never, done: true }); }
          };
          return {
            async next(): Promise<IteratorResult<GitMetaFrame>> {
              if (queue.length > 0) return { value: queue.shift()!, done: false };
              if (closed) return { value: undefined as never, done: true };
              return new Promise((resolve) => { waiter = resolve; });
            },
            async return(): Promise<IteratorResult<GitMetaFrame>> {
              cleanup();
              return { value: undefined as never, done: true };
            },
            async throw(e?: unknown): Promise<IteratorResult<GitMetaFrame>> {
              cleanup();
              throw e;
            },
          };
        },
      };
    },

    indexStatusStream({ id }): AsyncStream<ProjectIndexStatus> {
      if (!db.getProject(id)) throw new ApiError('not_found', 404, 'project not found');
      const svc = deps.projectIndexService;
      // Hand-rolled iterator (not streamFromCallbacks): a status stream is
      // INDEFINITE, so cancellation must unsubscribe — for-await calls
      // `return()` on break/throw, which is our cleanup hook. The callback
      // bridge has no return() and would leak the subscription forever.
      return {
        [Symbol.asyncIterator](): AsyncIterator<ProjectIndexStatus> {
          const queue: ProjectIndexStatus[] = [];
          let waiter: ((r: IteratorResult<ProjectIndexStatus>) => void) | null = null;
          let coalesceTimer: ReturnType<typeof setTimeout> | null = null;
          let pending: ProjectIndexStatus | null = null;
          let closed = false;
          const push = (s: ProjectIndexStatus) => {
            if (closed) return;
            if (waiter) { const w = waiter; waiter = null; w({ value: s, done: false }); }
            else queue.push(s);
          };
          const onStatus = (s: ProjectIndexStatus) => {
            pending = s;
            if (coalesceTimer) return;
            coalesceTimer = setTimeout(() => {
              coalesceTimer = null;
              if (pending) { const p = pending; pending = null; push(p); }
            }, 150);
          };
          const unsub = svc.subscribe(id, onStatus);
          push(svc.getStatus(id)); // initial frame
          const cleanup = () => {
            if (closed) return;
            closed = true;
            unsub();
            if (coalesceTimer) clearTimeout(coalesceTimer);
            if (waiter) { const w = waiter; waiter = null; w({ value: undefined as never, done: true }); }
          };
          return {
            async next(): Promise<IteratorResult<ProjectIndexStatus>> {
              if (queue.length > 0) return { value: queue.shift()!, done: false };
              if (closed) return { value: undefined as never, done: true };
              return new Promise((resolve) => { waiter = resolve; });
            },
            async return(): Promise<IteratorResult<ProjectIndexStatus>> {
              cleanup();
              return { value: undefined as never, done: true };
            },
            async throw(e?: unknown): Promise<IteratorResult<ProjectIndexStatus>> {
              cleanup();
              throw e;
            },
          };
        },
      };
    },

    async index({ id, ...input }) {
      return wrapAsync(() => lockedIndexRun(id, input as IndexProjectInput, () => indexUseCase.run(id, input as IndexProjectInput)));
    },

    indexStream({ id, ...input }): AsyncStream<IndexStreamEvent> {
      // Mirror every frame into the main-process status store. The manual run no
      // longer lives only in renderer state tied to the SSE fetch: the live pass
      // sits in the SoT, so navigating away and back re-hydrates the bar from the
      // status stream. The run promise is independent of whoever drains the SSE,
      // so a disconnect doesn't kill it — the store keeps updating either way.
      const svc = deps.projectIndexService;
      const runKind = (input as IndexProjectInput).mode === 'structural' ? 'structural' : 'semantic';
      const startedAt = Date.now();
      return streamFromCallbacks<IndexStreamEvent>((emit) =>
        lockedIndexRun(id, input as IndexProjectInput, () => indexUseCase.runStream(id, input as IndexProjectInput, {
          onStart: (p) => {
            svc.setActiveRun(id, { kind: runKind, current: 0, total: 0, startedAt });
            emit({ event: 'start', data: p });
          },
          onProgress: (p) => {
            svc.setActiveRun(id, {
              kind: runKind,
              current: p.current,
              total: p.total,
              currentFile: p.current_file || undefined,
              costUsd: p.cost_usd,
              startedAt,
            });
            emit({ event: 'progress', data: p });
          },
          onDone: (result) => {
            svc.refreshStatus(id); // clears the live pass + settles phase from DB
            emit({
              event: 'done',
              data: {
                runId: result.runId,
                totalFiles: result.totalFiles,
                indexedFiles: result.indexedFiles,
                skippedFiles: result.skippedFiles,
                errorCount: result.errorCount,
                durationMs: result.durationMs,
                costUsd: result.costUsd,
              },
            });
          },
          onError: (message) => {
            svc.refreshStatus(id);
            emit({ event: 'error', data: { message } });
          },
        })),
      );
    },

    retryEmbeddingsStream({ id }): AsyncStream<IndexStreamEvent> {
      const svc = deps.projectIndexService;
      const startedAt = Date.now();
      return streamFromCallbacks<IndexStreamEvent>((emit) =>
        indexUseCase.retryEmbeddingsStream(id, {
          onStart: (p) => {
            svc.setActiveRun(id, { kind: 'embeddings', current: 0, total: 0, startedAt });
            emit({ event: 'start', data: p });
          },
          onProgress: (p) => {
            svc.setActiveRun(id, { kind: 'embeddings', current: p.current, total: p.total, startedAt });
            emit({ event: 'progress', data: p });
          },
          onDone: (result) => {
            svc.refreshStatus(id);
            emit({ event: 'done', data: result as never });
          },
          onError: (message) => {
            svc.refreshStatus(id);
            emit({ event: 'error', data: { message } });
          },
        }),
      );
    },

    scaffold(input): AsyncStream<ScaffoldStreamEvent> {
      return streamFromCallbacks<ScaffoldStreamEvent>((emit) => runScaffoldStream(deps, input, emit));
    },
  };
}

// Re-exported so the Hono SSE route can reuse the same producer→iterable
// bridge the handlers use internally (keeps the scaffold route signal-aware
// without duplicating the queue logic).
export { streamFromCallbacks };

/**
 * Bridge between the legacy callback-based use-cases (`onStart`,
 * `onProgress`, `onDone`, `onError`) and the `AsyncIterable` contract the
 * api-bus exposes. The producer pushes events into a queue; the consumer
 * pulls them via `for await`. When the use-case promise settles, the
 * iterable closes (success) or throws (failure).
 *
 * This stays internal to api-handlers — handlers wrap their use-cases
 * once and never expose the queue. If we end up rewriting use-cases to
 * yield natively, this helper goes away.
 */
function streamFromCallbacks<T>(
  start: (emit: (value: T) => void) => Promise<void>,
): AsyncStream<T> {
  const queue: T[] = [];
  const waiters: Array<(v: IteratorResult<T>) => void> = [];
  let done = false;
  let error: unknown = null;

  const push = (value: T) => {
    if (waiters.length > 0) {
      const w = waiters.shift()!;
      w({ value, done: false });
    } else {
      queue.push(value);
    }
  };

  const finish = (err?: unknown) => {
    done = true;
    error = err;
    while (waiters.length > 0) {
      const w = waiters.shift()!;
      if (err) {
        // The throw path: route the error into the iterator via Symbol.asyncIterator's throw().
        // Simpler: resolve done and let next() check `error`.
        w({ value: undefined as never, done: true });
      } else {
        w({ value: undefined as never, done: true });
      }
    }
  };

  void start(push).then(
    () => finish(),
    (err) => finish(err),
  );

  return {
    [Symbol.asyncIterator](): AsyncIterator<T> {
      return {
        async next(): Promise<IteratorResult<T>> {
          if (error) throw error;
          if (queue.length > 0) {
            return { value: queue.shift()!, done: false };
          }
          if (done) return { value: undefined as never, done: true };
          return new Promise<IteratorResult<T>>((resolve) => {
            waiters.push(resolve);
          }).then((r) => {
            if (error) throw error;
            return r;
          });
        },
      };
    },
  };
}
