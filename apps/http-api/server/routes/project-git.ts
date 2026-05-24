/**
 * Hono adapter for the project-local git surface
 * (apps/http-api/server/routes/project-git.ts → @mcp/api-handlers/projectGit).
 * Distinct from /api/workspace/git which targets sandbox containers.
 */

import type { Context, Hono } from 'hono';
import { createProjectGitHandlers, createContext } from '@mcp/api-handlers';
import { ApiError } from '@mcp/api-bus';
import type { ServerDeps } from '../deps.js';
import { parseIdParam } from './_helpers.js';

function mapApiError(c: Context, err: unknown) {
  if (err instanceof ApiError) {
    return c.json({ error: err.message, code: err.code }, err.status as never);
  }
  throw err;
}

export function mountProjectGitRoutes(app: Hono, deps: ServerDeps): void {
  const h = createProjectGitHandlers(deps);

  app.get('/api/projects/:id/git/status', async (c) => {
    try {
      return c.json(await h.status({ projectId: parseIdParam(c) }, createContext()));
    } catch (err) {
      return mapApiError(c, err);
    }
  });

  app.post('/api/projects/:id/git/diff', async (c) => {
    try {
      const body = await c.req.json<{ path?: string; staged?: boolean }>();
      return c.json(
        await h.diff({ projectId: parseIdParam(c), path: body.path, staged: body.staged }, createContext()),
      );
    } catch (err) {
      return mapApiError(c, err);
    }
  });

  app.get('/api/projects/:id/git/log', async (c) => {
    try {
      const limit = Number(c.req.query('limit') ?? 30);
      const path = c.req.query('path') || undefined;
      return c.json(await h.log({ projectId: parseIdParam(c), limit, path }, createContext()));
    } catch (err) {
      return mapApiError(c, err);
    }
  });

  app.post('/api/projects/:id/git/stage', async (c) => {
    try {
      const body = await c.req.json<{ paths: string[] }>();
      return c.json(await h.stage({ projectId: parseIdParam(c), paths: body.paths ?? [] }, createContext()));
    } catch (err) {
      return mapApiError(c, err);
    }
  });

  app.post('/api/projects/:id/git/unstage', async (c) => {
    try {
      const body = await c.req.json<{ paths: string[] }>();
      return c.json(
        await h.unstage({ projectId: parseIdParam(c), paths: body.paths ?? [] }, createContext()),
      );
    } catch (err) {
      return mapApiError(c, err);
    }
  });

  app.post('/api/projects/:id/git/discard', async (c) => {
    try {
      const body = await c.req.json<{ paths: string[] }>();
      return c.json(
        await h.discard({ projectId: parseIdParam(c), paths: body.paths ?? [] }, createContext()),
      );
    } catch (err) {
      return mapApiError(c, err);
    }
  });

  app.post('/api/projects/:id/git/commit', async (c) => {
    try {
      const body = await c.req.json<{ message: string; amend?: boolean }>();
      if (!body.message) return c.json({ error: 'message required' }, 400);
      return c.json(
        await h.commit(
          { projectId: parseIdParam(c), message: body.message, amend: body.amend },
          createContext(),
        ),
      );
    } catch (err) {
      return mapApiError(c, err);
    }
  });

  app.get('/api/projects/:id/git/branches', async (c) => {
    try {
      return c.json(await h.branchList({ projectId: parseIdParam(c) }, createContext()));
    } catch (err) {
      return mapApiError(c, err);
    }
  });

  app.post('/api/projects/:id/git/checkout', async (c) => {
    try {
      const body = await c.req.json<{ name: string; create?: boolean }>();
      if (!body.name) return c.json({ error: 'name required' }, 400);
      return c.json(
        await h.branchCheckout(
          { projectId: parseIdParam(c), name: body.name, create: body.create },
          createContext(),
        ),
      );
    } catch (err) {
      return mapApiError(c, err);
    }
  });
}
