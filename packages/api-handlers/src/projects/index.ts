/**
 * Handlers for the `projects` namespace. Pure functions over the shared
 * `HandlerDeps`; no Hono, no Electron. The legacy Hono routes in
 * apps/http-api/server/routes/projects.ts now delegate here.
 */

import { ApiError, type ApiContext, type AsyncStream, type ProjectsApi, type ProjectIndexStatus, type FsEventsFrame, type GitMetaFrame, type ScaffoldStreamEvent } from '@mcp/api-bus';
import { runScaffoldStream } from './scaffold.js';
import { detectProjectFramework } from './detect-framework.js';
import {
  CreateProjectService,
  UpdateProjectService,
  ProjectError,
  type CreateProjectInput,
  type UpdateProjectInput,
} from '@mcp/services/services/projects/index.js';
import { clearProjectEdits } from '../editor/completion/snippets/edit-tracker.js';
import { closeProjectDocs } from '../lsp/document-store.js';
import { getLspServerManager } from '@mcp/services/lsp/lsp-server-manager.js';
import type { HandlerDeps } from '../types.js';
import {
  codeNamespace,
  projectMemoryNamespace,
  snapshotNamespace,
} from '@mcp/shared/vector-namespace.js';

/** Process-global: survives dual handler factories and dev HMR module reloads. */
const activationGlobal = globalThis as typeof globalThis & {
  __mcpProjectClientActivations?: Map<string, { projectId: number; activationId: string }>;
};
const clientActivations = activationGlobal.__mcpProjectClientActivations ??= new Map();

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

export function createProjectsHandlers(deps: HandlerDeps): ProjectsApi {
  const { db } = deps;

  const createService = new CreateProjectService(db);
  const updateService = new UpdateProjectService(db);

  async function parkProjectLanguageServices(projectId: number): Promise<void> {
    // closeProjectDocs forwards didClose to ready servers before the manager
    // parks the processes for fast return. The manager enforces the warm LRU.
    closeProjectDocs(projectId);
    await getLspServerManager()?.parkProject(projectId);
  }

  async function stopProjectLanguageServices(projectId: number): Promise<void> {
    closeProjectDocs(projectId);
    await getLspServerManager()?.stopProject(projectId);
  }
  // Remove only this project's local vectors.db. Shared documentation and
  // user-memory databases are routed elsewhere and remain untouched.
  async function clearProjectVectors(
    project: { id: number; name: string },
    options: {
      finalize?: () => void | Promise<void>;
      retainProject?: boolean;
    } = {},
  ): Promise<{ known: number; deleted: number; error: string | null }> {
    const namespaces = [
      codeNamespace(project.id),
      snapshotNamespace(project.id),
      projectMemoryNamespace(project.id),
    ];
    const known = namespaces.reduce((count, namespace) => {
      const state = deps.semanticStore.listNamespaceGenerations({ namespace })[0];
      const generations = new Set([
        state?.active_generation_id,
        state?.building_generation_id,
      ].filter((id): id is number => id !== null && id !== undefined));
      for (const generationId of generations) {
        count += deps.semanticStore.listItems({
          generation_id: generationId,
          namespace,
        }).length;
      }
      return count;
    }, 0);
    let deleted = 0;
    let error: string | null = null;
    try {
      await deps.semanticCoordinator.removeProject(project.id, options);
      deleted = known;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
    return { known, deleted, error };
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
      // Cheap package.json read — classifies the framework so the preview pane
      // can auto-pick the React-native element picker over the universal one.
      return { ...project, framework: detectProjectFramework(project.root_path) };
    },

    async activate({ id, activationId, clientId }) {
      if (!db.getProject(id)) throw new ApiError('not_found', 404, 'project not found');
      if (!activationId || activationId.length > 128) {
        throw new ApiError('invalid_activation_id', 400, 'activationId is required');
      }
      if (!clientId || clientId.length > 128) {
        throw new ApiError('invalid_client_id', 400, 'clientId is required');
      }
      const previous = clientActivations.get(clientId);
      if (previous && (previous.projectId !== id || previous.activationId !== activationId)) {
        const lastPreviousView = deps.projectIndexService.deactivate(previous.projectId, previous.activationId);
        if (lastPreviousView && previous.projectId !== id) {
          await parkProjectLanguageServices(previous.projectId);
        }
      }
      clientActivations.set(clientId, { projectId: id, activationId });
      getLspServerManager()?.activateProject(id);
      const result = deps.projectIndexService.activate(id, activationId);
      return { ok: true as const, ...result };
    },

    async deactivate({ id, activationId, clientId }) {
      const current = clientActivations.get(clientId);
      // Delayed cleanup from a superseded navigation/HMR generation.
      if (!current || current.projectId !== id || current.activationId !== activationId) {
        return { ok: true as const };
      }
      clientActivations.delete(clientId);
      const lastView = deps.projectIndexService.deactivate(id, activationId);
      if (lastView) await parkProjectLanguageServices(id);
      return { ok: true as const };
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
      await stopProjectLanguageServices(id);
      for (const [clientId, activation] of clientActivations) {
        if (activation.projectId === id) clientActivations.delete(clientId);
      }
      clearProjectEdits(id); // completion edit-tracker: drop the project's ring
      const v = await clearProjectVectors(project, {
        finalize: () => db.deleteProject(id),
      });
      if (v.error) {
        deps.projectIndexService.restartFileWatching(id);
        throw new ApiError(
          'semantic_cleanup_failed',
          409,
          `project kept because semantic cleanup failed: ${v.error}`,
        );
      }
      return {
        ok: true as const,
        vectors_known: v.known,
        vectors_deleted: v.deleted,
        vector_error: v.error,
      };
    },

    async clearData({ id }) {
      const project = db.getProject(id);
      if (!project) throw new ApiError('not_found', 404, 'project not found');
      const v = await clearProjectVectors(project, {
        finalize: () => db.clearProjectData(id),
        retainProject: true,
      });
      if (v.error) {
        throw new ApiError(
          'semantic_cleanup_failed',
          409,
          `project data kept because semantic cleanup failed: ${v.error}`,
        );
      }
      deps.hybridSearch?.invalidateCache?.();
      return {
        ok: true as const,
        vectors_known: v.known,
        vectors_deleted: v.deleted,
        vector_error: v.error,
      };
    },

    async clearAllData() {
      // Wipe every project's data (index, sessions, snapshots, runs, costs) +
      // its local vectors, but KEEP each project row so the user only has to
      // re-index — not re-create. Errors per project are collected, not fatal.
      const all = db.listProjects();
      let projectsCleared = 0;
      let vectorsDeleted = 0;
      const errors: Array<{ project: string; error: string }> = [];
      for (const project of all) {
        const v = await clearProjectVectors(project, {
          finalize: () => db.clearProjectData(project.id),
          retainProject: true,
        });
        if (v.error) {
          // Keep the relational project data intact when the worker could not
          // drain/checkpoint its vectors.db. Deleting it here would bypass the
          // semantic owner and leave the project half-cleared.
          errors.push({ project: project.name, error: v.error });
          continue;
        }
        vectorsDeleted += v.deleted;
        projectsCleared++;
      }
      // Drop the in-memory search caches so stale results don't linger.
      deps.hybridSearch?.invalidateCache?.();
      return {
        ok: true as const,
        projects_cleared: projectsCleared,
        vectors_deleted: vectorsDeleted,
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
