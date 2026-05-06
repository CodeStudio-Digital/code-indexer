import type { Context, Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { ServerDeps } from '../deps.js';
import { parseIdParam, parseJsonBody, notFound } from './_helpers.js';
import {
  CreateProjectService,
  UpdateProjectService,
  IndexProjectUseCase,
  ProjectError,
  type CreateProjectInput,
  type UpdateProjectInput,
  type IndexProjectInput,
} from '../../../../core/services/projects/index.js';

/**
 * Map a domain ProjectError to its HTTP response. Keeps route handlers a
 * single line — everything else is delegated to the use-case layer.
 */
function mapProjectError(c: Context, err: unknown) {
  if (err instanceof ProjectError) {
    return c.json({ error: err.message }, err.statusCode);
  }
  throw err;
}

export function mountProjectsRoutes(app: Hono, deps: ServerDeps): void {
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
  });

  app.get('/api/projects', (c) => c.json(db.listProjects()));

  app.post('/api/projects', async (c) => {
    const body = await parseJsonBody<CreateProjectInput>(c);
    try {
      return c.json(createService.execute(body as CreateProjectInput), 201);
    } catch (err) {
      return mapProjectError(c, err);
    }
  });

  app.get('/api/projects/:id', (c) => {
    const project = db.getProject(parseIdParam(c));
    if (!project) return notFound(c);
    return c.json(project);
  });

  app.patch('/api/projects/:id', async (c) => {
    const id = parseIdParam(c);
    const body = await parseJsonBody<UpdateProjectInput>(c);
    try {
      return c.json(updateService.execute(id, body as UpdateProjectInput));
    } catch (err) {
      return mapProjectError(c, err);
    }
  });

  /**
   * Cascading delete: pull every vector_id we have on record for the
   * project, hand them to the remote vector store, then drop the
   * SQLite row (which cascades to vector_ids/files/symbols/etc).
   *
   * If the remote delete fails — Worker offline, network blip — we
   * still drop the local rows but enqueue the ids in
   * `pending_vector_deletes` so the Hygiene panel can retry. Without
   * this, deleting a project from the dashboard accumulated orphans
   * in Cloudflare Vectorize indefinitely.
   */
  app.delete('/api/projects/:id', async (c) => {
    const id = parseIdParam(c);
    const project = db.getProject(id);
    if (!project) return notFound(c);

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
            error: remoteError,
          })),
        );
      }
    }

    db.deleteProject(id);
    return c.json({
      ok: true,
      vectors_known: vectorIds.length,
      vectors_deleted_remote: remoteDeleted,
      remote_error: remoteError,
    });
  });

  app.post('/api/projects/:id/index', async (c) => {
    const projectId = parseIdParam(c);
    const body = await parseJsonBody<IndexProjectInput>(c);
    try {
      return c.json(await indexUseCase.run(projectId, body));
    } catch (err) {
      return mapProjectError(c, err);
    }
  });

  /**
   * Streaming index — runs the same pipeline but pushes IndexProgress frames
   * over SSE. `IndexProjectUseCase.runStream` centralizes the coalescing and
   * provider-resolution logic; this route just wires callbacks to the stream.
   */
  app.post('/api/projects/:id/index/stream', async (c) => {
    const projectId = parseIdParam(c);
    const project = db.getProject(projectId);
    if (!project) return notFound(c);

    const body = await parseJsonBody<IndexProjectInput>(c);

    return streamSSE(c, async (stream) => {
      let seq = 0;
      const send = (event: string, data: unknown) =>
        stream.writeSSE({
          id: String(seq++),
          event,
          data: JSON.stringify(data),
        });

      await indexUseCase.runStream(projectId, body, {
        onStart: (p) => send('start', p),
        onProgress: (p) => send('progress', p),
        onDone: (result) => send('done', {
          run_id: result.runId,
          total_files: result.totalFiles,
          indexed_files: result.indexedFiles,
          skipped_files: result.skippedFiles,
          error_count: result.errorCount,
          duration_ms: result.durationMs,
          cost_usd: result.costUsd,
        }),
        onError: (message) => send('error', { message }),
      });

      await stream.close();
    });
  });

  /**
   * Retry failed/missing embeddings — runs only the embedding pipeline
   * (no LLM analysis). Streams progress over SSE.
   */
  app.post('/api/projects/:id/embeddings/retry/stream', async (c) => {
    const projectId = parseIdParam(c);
    const project = db.getProject(projectId);
    if (!project) return notFound(c);

    return streamSSE(c, async (stream) => {
      let seq = 0;
      const send = (event: string, data: unknown) =>
        stream.writeSSE({
          id: String(seq++),
          event,
          data: JSON.stringify(data),
        });

      await indexUseCase.retryEmbeddingsStream(projectId, {
        onStart: (p) => send('start', p),
        onProgress: (p) => send('progress', p),
        onDone: (result) => send('done', result),
        onError: (message) => send('error', { message }),
      });

      await stream.close();
    });
  });
}
