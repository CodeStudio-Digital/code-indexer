import type { Hono } from 'hono';
import type { ServerDeps } from '../deps.js';
import { createProjectsHandlers } from '@mcp/api-handlers/projects/index.js';
import { createContext } from '@mcp/api-handlers/context.js';
import { parseJsonBody } from './_helpers.js';
import { BulkProjectDeleteError, executeBulkProjectDelete, type BulkProjectDeleteInput } from './project-bulk-delete.js';
import { mapApiError } from './project-route-errors.js';

export function mountProjectCollectionRoutes(app: Hono, deps: ServerDeps, h: ReturnType<typeof createProjectsHandlers>): void {



  app.get('/api/projects', async (c) => {
    try {
      // `?include_loose=1` returns the global-session picker superset (real
      // projects + loose ad-hoc folders, mig 176). Default = the grid list.
      const includeLoose = c.req.query('include_loose') === '1';
      const list = includeLoose
        ? await h.listForGlobalPicker(undefined, createContext())
        : await h.list(undefined, createContext());
      return c.json(list);
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

  // Collection-level danger action — wipes every project's data but keeps the
  // rows. Registered before the `:id` routes; it's a distinct literal segment.
  app.post('/api/projects/clear-all-data', async (c) => {
    try {
      return c.json(await h.clearAllData(undefined, createContext()));
    } catch (err) {
      return mapApiError(c, err);
    }
  });

  app.post('/api/projects/bulk-delete', async (c) => {
    try {
      const body = await parseJsonBody<BulkProjectDeleteInput>(c);
      const result = await executeBulkProjectDelete(body as BulkProjectDeleteInput, {
        getProject: (id) => deps.db.getProject(id),
        listProjects: () => deps.db.listProjectsForGlobalPicker(),
        deleteCatalogProject: async (id) => {
          await h.delete({ id }, createContext());
        },
      });
      return c.json(result);
    } catch (err) {
      if (err instanceof BulkProjectDeleteError) {
        return c.json({ error: err.message, code: 'unsafe_bulk_delete' }, err.status);
      }
      return mapApiError(c, err);
    }
  });
}
