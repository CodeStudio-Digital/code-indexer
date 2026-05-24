/**
 * Handlers for the `projects` namespace. Pure functions over the shared
 * `HandlerDeps`; no Hono, no Electron. The legacy Hono routes in
 * apps/http-api/server/routes/projects.ts now delegate here.
 */

import { ApiError, type ApiContext, type AsyncStream, type ProjectsApi, type IndexStreamEvent } from '@mcp/api-bus';
import {
  CreateProjectService,
  UpdateProjectService,
  IndexProjectUseCase,
  ProjectError,
  type CreateProjectInput,
  type UpdateProjectInput,
  type IndexProjectInput,
} from '@mcp/services/services/projects/index.js';
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
  });

  return {
    async list(_input, _ctx: ApiContext) {
      return db.listProjects();
    },

    async get({ id }) {
      const project = db.getProject(id);
      if (!project) throw new ApiError('not_found', 404, 'project not found');
      return project;
    },

    async create(input) {
      return wrap(() => createService.execute(input as CreateProjectInput));
    },

    async update({ id, ...patch }) {
      const result = wrap(() => updateService.execute(id, patch as UpdateProjectInput));
      if (!result) throw new ApiError('not_found', 404, 'project not found');
      return result;
    },

    async delete({ id }) {
      const project = db.getProject(id);
      if (!project) throw new ApiError('not_found', 404, 'project not found');

      const vectorIds = db.snapshotVectorIdsForProject(id);
      let remoteDeleted = 0;
      let remoteError: string | null = null;

      if (vectorIds.length > 0) {
        try {
          remoteDeleted = await vectorStore.deleteByIds(vectorIds);
        } catch (err) {
          remoteError = err instanceof Error ? err.message : String(err);
          db.enqueuePendingVectorDeletes(
            vectorIds.map((vid) => ({
              vector_id: vid,
              project_name: project.name,
              error: remoteError!,
            })),
          );
        }
      }

      db.deleteProject(id);
      return {
        ok: true as const,
        vectors_known: vectorIds.length,
        vectors_deleted_remote: remoteDeleted,
        remote_error: remoteError,
      };
    },

    async stats({ id }) {
      // The legacy route lives in stats.ts but it's keyed by projectId,
      // so it naturally belongs to ProjectsApi. Mirrors GET /api/projects/:id/stats.
      return db.getStats(id);
    },

    async index({ id, ...input }) {
      return wrapAsync(() => indexUseCase.run(id, input as IndexProjectInput));
    },

    indexStream({ id, ...input }): AsyncStream<IndexStreamEvent> {
      return streamFromCallbacks<IndexStreamEvent>((emit) =>
        indexUseCase.runStream(id, input as IndexProjectInput, {
          onStart: (p) => emit({ event: 'start', data: p }),
          onProgress: (p) => emit({ event: 'progress', data: p }),
          onDone: (result) =>
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
            }),
          onError: (message) => emit({ event: 'error', data: { message } }),
        }),
      );
    },

    retryEmbeddingsStream({ id }): AsyncStream<IndexStreamEvent> {
      return streamFromCallbacks<IndexStreamEvent>((emit) =>
        indexUseCase.retryEmbeddingsStream(id, {
          onStart: (p) => emit({ event: 'start', data: p }),
          onProgress: (p) => emit({ event: 'progress', data: p }),
          onDone: (result) => emit({ event: 'done', data: result as never }),
          onError: (message) => emit({ event: 'error', data: { message } }),
        }),
      );
    },
  };
}

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
