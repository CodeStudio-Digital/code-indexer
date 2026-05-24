import type { Context, Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { createProjectsHandlers, createContext } from '@mcp/api-handlers';
import { ApiError } from '@mcp/api-bus';
import type { ServerDeps } from '../deps.js';
import { parseIdParam, parseJsonBody, notFound } from './_helpers.js';

/**
 * Hono routes for /api/projects/* — thin adapters that parse the request,
 * invoke the corresponding handler in `@mcp/api-handlers/projects`, and
 * serialize the result. The handlers are also mounted on Electron IPC
 * (see apps/electron/src/ipc/) so the business logic stays in one place.
 *
 * SSE adaptation: handlers return `AsyncIterable<IndexStreamEvent>`;
 * this file wraps that iterable into Hono's streamSSE frames. The
 * Electron transport instead pumps it onto a MessagePort.
 */
function mapApiError(c: Context, err: unknown) {
  if (err instanceof ApiError) {
    return c.json({ error: err.message, code: err.code, ...(err.details ?? {}) }, err.status as never);
  }
  throw err;
}

export function mountProjectsRoutes(app: Hono, deps: ServerDeps): void {
  const h = createProjectsHandlers(deps);

  app.get('/api/projects', async (c) => {
    try {
      return c.json(await h.list(undefined, createContext()));
    } catch (err) {
      return mapApiError(c, err);
    }
  });

  app.post('/api/projects', async (c) => {
    try {
      const body = await parseJsonBody<Parameters<typeof h.create>[0]>(c);
      return c.json(await h.create(body as Parameters<typeof h.create>[0], createContext()), 201);
    } catch (err) {
      return mapApiError(c, err);
    }
  });

  app.get('/api/projects/:id', async (c) => {
    try {
      return c.json(await h.get({ id: parseIdParam(c) }, createContext()));
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) return notFound(c);
      return mapApiError(c, err);
    }
  });

  app.patch('/api/projects/:id', async (c) => {
    try {
      const id = parseIdParam(c);
      const body = await parseJsonBody<Omit<Parameters<typeof h.update>[0], 'id'>>(c);
      return c.json(await h.update({ id, ...body }, createContext()));
    } catch (err) {
      return mapApiError(c, err);
    }
  });

  app.delete('/api/projects/:id', async (c) => {
    try {
      return c.json(await h.delete({ id: parseIdParam(c) }, createContext()));
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) return notFound(c);
      return mapApiError(c, err);
    }
  });

  app.post('/api/projects/:id/index', async (c) => {
    try {
      const id = parseIdParam(c);
      const body = await parseJsonBody<Omit<Parameters<typeof h.index>[0], 'id'>>(c);
      return c.json(await h.index({ id, ...body }, createContext()));
    } catch (err) {
      return mapApiError(c, err);
    }
  });

  /**
   * Streaming index — pumps the handler's AsyncIterable into SSE frames.
   * Electron will pump the same iterable onto a MessagePort instead.
   */
  app.post('/api/projects/:id/index/stream', async (c) => {
    const id = parseIdParam(c);
    const project = deps.db.getProject(id);
    if (!project) return notFound(c);

    const body = await parseJsonBody<Omit<Parameters<typeof h.indexStream>[0], 'id'>>(c);
    return streamSSE(c, async (stream) => {
      let seq = 0;
      try {
        for await (const ev of h.indexStream({ id, ...body }, createContext())) {
          await stream.writeSSE({
            id: String(seq++),
            event: ev.event,
            data: JSON.stringify(ev.data),
          });
        }
      } finally {
        await stream.close();
      }
    });
  });

  app.post('/api/projects/:id/embeddings/retry/stream', async (c) => {
    const id = parseIdParam(c);
    const project = deps.db.getProject(id);
    if (!project) return notFound(c);

    return streamSSE(c, async (stream) => {
      let seq = 0;
      try {
        for await (const ev of h.retryEmbeddingsStream({ id }, createContext())) {
          await stream.writeSSE({
            id: String(seq++),
            event: ev.event,
            data: JSON.stringify(ev.data),
          });
        }
      } finally {
        await stream.close();
      }
    });
  });
}
