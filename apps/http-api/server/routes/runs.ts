import type { Context, Hono } from 'hono';
import { createRunsHandlers, createContext } from '@mcp/api-handlers';
import { ApiError } from '@mcp/api-bus';
import type { ServerDeps } from '../deps.js';
import { parseIdParam, notFound } from './_helpers.js';

function mapApiError(c: Context, err: unknown) {
  if (err instanceof ApiError) {
    return c.json({ error: err.message, code: err.code }, err.status as never);
  }
  throw err;
}

export function mountRunsRoutes(app: Hono, deps: ServerDeps): void {
  const h = createRunsHandlers(deps);

  app.get('/api/projects/:id/runs', async (c) => {
    try {
      return c.json(await h.list({ projectId: parseIdParam(c) }, createContext()));
    } catch (err) {
      return mapApiError(c, err);
    }
  });

  app.get('/api/runs/:id', async (c) => {
    try {
      return c.json(await h.get({ id: parseIdParam(c) }, createContext()));
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) return notFound(c);
      return mapApiError(c, err);
    }
  });
}
