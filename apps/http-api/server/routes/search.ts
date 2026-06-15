import type { Context, Hono } from 'hono';
import { createSearchHandlers, createContext } from '@mcp/api-handlers';
import { ApiError } from '@mcp/api-bus';
import type { SearchMode, SearchType } from '@mcp/shared/types.js';
import type { ServerDeps } from '../deps.js';
import { parseIdParam, parseIntQuery } from './_helpers.js';

function mapApiError(c: Context, err: unknown) {
  if (err instanceof ApiError) {
    return c.json({ error: err.message, code: err.code }, err.status as never);
  }
  throw err;
}

export function mountSearchRoutes(app: Hono, deps: ServerDeps): void {
  const h = createSearchHandlers(deps);

  app.get('/api/projects/:id/search', async (c) => {
    try {
      const projectId = parseIdParam(c);
      const query = c.req.query('q') ?? '';
      const mode = c.req.query('mode') as SearchMode | undefined;
      const type = c.req.query('type') as SearchType | undefined;
      const limit = parseIntQuery(c, 'limit', 20);
      return c.json(await h.project({ projectId, query, mode, type, limit }, createContext()));
    } catch (err) {
      return mapApiError(c, err);
    }
  });

  app.get('/api/search', async (c) => {
    try {
      const query = c.req.query('q') ?? '';
      const limit = parseIntQuery(c, 'limit', 20);
      return c.json(await h.global({ query, limit }, createContext()));
    } catch (err) {
      return mapApiError(c, err);
    }
  });

  /** Search Everywhere — thin FTS tabs (Symbols / Text), <20ms targets. */
  app.get('/api/projects/:id/search/symbols', async (c) => {
    try {
      const projectId = parseIdParam(c);
      const query = c.req.query('q') ?? '';
      const limit = parseIntQuery(c, 'limit', 50);
      return c.json(await h.symbols({ projectId, query, limit }, createContext()));
    } catch (err) {
      return mapApiError(c, err);
    }
  });

  app.get('/api/projects/:id/search/text', async (c) => {
    try {
      const projectId = parseIdParam(c);
      const query = c.req.query('q') ?? '';
      const limit = parseIntQuery(c, 'limit', 50);
      return c.json(await h.text({ projectId, query, limit }, createContext()));
    } catch (err) {
      return mapApiError(c, err);
    }
  });
}
