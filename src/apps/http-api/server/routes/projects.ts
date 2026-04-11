import type { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { existsSync, statSync } from 'node:fs';
import { basename, resolve as resolvePath } from 'node:path';
import { createProviderAsync } from '../../../../core/providers/factory.js';
import { IndexAgent, type EmbeddingProgress } from '../../../../core/indexer/indexer.js';
import type { ProviderName, IndexProgress } from '../../../../types.js';
import type { ServerDeps } from '../deps.js';

interface CreateProjectBody {
  name?: string;
  root_path: string;
  description?: string;
}

interface UpdateProjectBody {
  name?: string;
  description?: string;
  group_name?: string | null;
  root_path?: string;
}

interface IndexProjectBody {
  provider?: string;
  model?: string;
  force?: boolean;
  concurrent?: number;
}

export function mountProjectsRoutes(app: Hono, deps: ServerDeps): void {
  const { db, config, embeddingService, vectorStore, costTracker, webhookDispatcher } = deps;

  app.get('/api/projects', (c) => {
    return c.json(db.listProjects());
  });

  app.post('/api/projects', async (c) => {
    const body = await c.req.json<CreateProjectBody>().catch(() => ({} as CreateProjectBody));
    if (!body.root_path || typeof body.root_path !== 'string') {
      return c.json({ error: 'root_path is required' }, 400);
    }

    const absPath = resolvePath(body.root_path);
    if (!existsSync(absPath) || !statSync(absPath).isDirectory()) {
      return c.json({ error: `root_path "${absPath}" is not an existing directory` }, 400);
    }

    const existingByPath = db.getProjectByPath(absPath);
    if (existingByPath && existingByPath.root_path === absPath) {
      return c.json({ error: `root_path "${absPath}" already used by project "${existingByPath.name}"` }, 409);
    }

    // Derive default name from the last 2 path segments when omitted.
    let name = (body.name ?? '').trim();
    if (!name) {
      const parts = absPath.replace(/\\/g, '/').split('/').filter(Boolean);
      name = parts.slice(-2).join('/') || basename(absPath) || 'project';
    }

    const existingByName = db.getProjectByName(name);
    if (existingByName) {
      return c.json({ error: `Project name "${name}" already in use` }, 409);
    }

    const project = db.createProject(name, absPath, body.description);
    return c.json(project, 201);
  });

  app.get('/api/projects/:id', (c) => {
    const project = db.getProject(parseInt(c.req.param('id'), 10));
    if (!project) return c.json({ error: 'Not found' }, 404);
    return c.json(project);
  });

  app.patch('/api/projects/:id', async (c) => {
    const id = parseInt(c.req.param('id'), 10);
    const project = db.getProject(id);
    if (!project) return c.json({ error: 'Not found' }, 404);

    const body = await c.req.json<UpdateProjectBody>().catch(() => ({} as UpdateProjectBody));
    const updates: UpdateProjectBody = {};

    if (body.name !== undefined) {
      const name = body.name.trim();
      if (!name) return c.json({ error: 'name cannot be empty' }, 400);
      const existing = db.getProjectByName(name);
      if (existing && existing.id !== id) {
        return c.json({ error: `Project name "${name}" already in use` }, 409);
      }
      updates.name = name;
    }

    if (body.description !== undefined) {
      updates.description = body.description;
    }

    if (body.group_name !== undefined) {
      updates.group_name = body.group_name || null;
    }

    if (body.root_path !== undefined) {
      const absPath = resolvePath(body.root_path);
      if (!existsSync(absPath) || !statSync(absPath).isDirectory()) {
        return c.json({ error: `root_path "${absPath}" is not an existing directory` }, 400);
      }
      const existing = db.getProjectByPath(absPath);
      if (existing && existing.id !== id) {
        return c.json({ error: `root_path "${absPath}" already used by another project` }, 409);
      }
      updates.root_path = absPath;
    }

    db.updateProject(id, updates);
    return c.json(db.getProject(id));
  });

  app.delete('/api/projects/:id', (c) => {
    db.deleteProject(parseInt(c.req.param('id'), 10));
    return c.json({ ok: true });
  });

  app.post('/api/projects/:id/index', async (c) => {
    const projectId = parseInt(c.req.param('id'), 10);
    const project = db.getProject(projectId);
    if (!project) return c.json({ error: 'Not found' }, 404);

    const body = await c.req
      .json<IndexProjectBody>()
      .catch((): Record<string, never> => ({}));
    const provider = await createProviderAsync(
      (body.provider ?? config.provider) as ProviderName,
      body.model ?? config.model,
    );
    const agent = new IndexAgent(
      db,
      provider,
      embeddingService,
      vectorStore,
      costTracker,
      webhookDispatcher,
      config,
    );

    const result = await agent.indexProject(project.root_path, { force: body.force });
    return c.json(result);
  });

  /**
   * Streaming index — runs the same pipeline but pushes IndexProgress frames
   * over SSE so the dashboard can render a live progress bar. Each file emits
   * a `progress` event; terminal states emit `done` (with IndexResult) or
   * `error` (with a message).
   */
  app.post('/api/projects/:id/index/stream', async (c) => {
    const projectId = parseInt(c.req.param('id'), 10);
    const project = db.getProject(projectId);
    if (!project) return c.json({ error: 'Not found' }, 404);

    const body = await c.req
      .json<IndexProjectBody>()
      .catch((): Record<string, never> => ({}));

    return streamSSE(c, async (stream) => {
      let seq = 0;
      const send = (event: string, data: unknown) =>
        stream.writeSSE({
          id: String(seq++),
          event,
          data: JSON.stringify(data),
        });

      try {
        await send('start', {
          project_id: project.id,
          project_name: project.name,
          provider: body.provider ?? config.provider,
          model: body.model ?? config.model,
          force: !!body.force,
          started_at: new Date().toISOString(),
          concurrent: body.concurrent ?? 5,
        });

        const provider = await createProviderAsync(
          (body.provider ?? config.provider) as ProviderName,
          body.model ?? config.model,
        );
        const agent = new IndexAgent(
          db,
          provider,
          embeddingService,
          vectorStore,
          costTracker,
          webhookDispatcher,
          {
            ...config,
            concurrency: body.concurrent ?? 5,
          },
        );

        // Coalesce progress events to at most one frame per ~120ms so chatty
        // concurrency runs don't flood the SSE channel. Terminal frames are
        // always flushed on done.
        let lastFlushed = 0;
        let latest: IndexProgress | null = null;
        const flush = async () => {
          if (!latest) return;
          const p = latest;
          latest = null;
          await send('progress', {
            current: p.current,
            total: p.total,
            current_file: p.currentFile,
            elapsed_ms: p.elapsedMs,
            cost_usd: p.costUsd,
            percent: p.total > 0 ? Math.round((p.current / p.total) * 100) : 0,
          });
        };

        const result = await agent.indexProject(project.root_path, {
          force: body.force,
          onProgress: (p) => {
            latest = p;
            const now = Date.now();
            if (p.current === p.total || now - lastFlushed > 120) {
              lastFlushed = now;
              void flush();
            }
          },
        });
        await flush();

        await send('done', {
          run_id: result.runId,
          total_files: result.totalFiles,
          indexed_files: result.indexedFiles,
          skipped_files: result.skippedFiles,
          error_count: result.errorCount,
          duration_ms: result.durationMs,
          cost_usd: result.costUsd,
        });
      } catch (err) {
        await send('error', {
          message: err instanceof Error ? err.message : String(err),
        });
      } finally {
        await stream.close();
      }
    });
  });

  /**
   * Retry failed/missing embeddings — runs only the embedding pipeline
   * (no LLM analysis). Streams progress over SSE.
   */
  app.post('/api/projects/:id/embeddings/retry/stream', async (c) => {
    const projectId = parseInt(c.req.param('id'), 10);
    const project = db.getProject(projectId);
    if (!project) return c.json({ error: 'Not found' }, 404);

    return streamSSE(c, async (stream) => {
      let seq = 0;
      const send = (event: string, data: unknown) =>
        stream.writeSSE({
          id: String(seq++),
          event,
          data: JSON.stringify(data),
        });

      try {
        await send('start', {
          project_id: project.id,
          project_name: project.name,
          started_at: new Date().toISOString(),
        });

        // IndexAgent needs a provider but retryEmbeddings doesn't use it.
        // Create a minimal agent with a dummy provider — only embedding
        // service and vector store matter.
        const dummyProvider = { name: 'none', model: 'none', analyzeFile: () => { throw new Error('not used'); } } as unknown as import('../../../../core/indexer/providers/base.js').LLMProvider;
        const agent = new IndexAgent(
          db,
          dummyProvider,
          embeddingService,
          vectorStore,
          costTracker,
          webhookDispatcher,
          config,
        );

        let lastFlushed = 0;
        let latest: EmbeddingProgress | null = null;
        const flush = async () => {
          if (!latest) return;
          const p = latest;
          latest = null;
          await send('progress', {
            current: p.current,
            total: p.total,
            percent: p.percent,
          });
        };

        const result = await agent.retryEmbeddings(project.root_path, {
          onProgress: (p) => {
            latest = p;
            const now = Date.now();
            if (p.current === p.total || now - lastFlushed > 120) {
              lastFlushed = now;
              void flush();
            }
          },
        });
        await flush();

        await send('done', {
          embedded: result.embedded,
          skipped: result.skipped,
          tokens: result.tokens,
        });
      } catch (err) {
        await send('error', {
          message: err instanceof Error ? err.message : String(err),
        });
      } finally {
        await stream.close();
      }
    });
  });
}
