import type { Hono } from 'hono';
import type { SnapshotCategory } from '@mcp/shared/types.js';
import type { ServerDeps } from '../deps.js';
import { parseIdParam } from './_helpers.js';

/**
 * Global USER memory CRUD (migration 145) — the human-facing surface for the
 * cross-project "who I am / how I want you to work" facts the agent reads on
 * every project. Backed by the reserved user project (id 0) with scope 'user';
 * every write is stamped scope 'user' and the category is constrained to
 * user | feedback so this surface can never create project-scoped rows.
 */
const USER_PROJECT_ID = 0;

function userCategory(raw: unknown): SnapshotCategory {
  return raw === 'user' ? 'user' : 'feedback';
}

export function mountUserMemoryRoutes(app: Hono, deps: ServerDeps): void {
  app.get('/api/user-memory', (c) => c.json(deps.db.listSnapshots(USER_PROJECT_ID)));

  app.get('/api/user-memory/health', (c) =>
    c.json({
      memory_enabled: true,
      last: deps.db.latestMemoryDistill(USER_PROJECT_ID),
      recent: deps.db.recentMemoryDistills(USER_PROJECT_ID, 10),
      totals: {
        total: deps.db.countSnapshots(USER_PROJECT_ID),
        byCategory: deps.db.countMemoryByCategory(USER_PROJECT_ID),
        bySource: deps.db.countMemoryBySource(USER_PROJECT_ID),
        archived: deps.db.countArchivedSnapshots(USER_PROJECT_ID),
      },
    }),
  );

  app.post('/api/user-memory', async (c) => {
    const body = await c.req.json<{ title: string; content: string; category?: string }>();
    const res = await deps.snapshotService.create(USER_PROJECT_ID, {
      title: body.title,
      content: body.content,
      category: userCategory(body.category),
      source: 'manual',
      scope: 'user',
    });
    return c.json(res.snap, 201);
  });

  app.put('/api/user-memory/:id', async (c) => {
    const body = await c.req.json<{ title?: string; content?: string; category?: string; importance?: number }>();
    const res = await deps.snapshotService.update(parseIdParam(c), {
      title: body.title,
      content: body.content,
      category: body.category != null ? userCategory(body.category) : undefined,
      importance: body.importance,
      projectId: USER_PROJECT_ID,
    });
    return c.json(res.snap);
  });

  app.delete('/api/user-memory/:id', (c) => {
    deps.snapshotService.delete(parseIdParam(c));
    return c.json({ ok: true });
  });
}
