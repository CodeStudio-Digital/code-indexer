import type { Hono } from 'hono';
import { AgentMemoryWriter } from '@mcp/services/memory/agent-memory-writer.js';
import type { ServerDeps } from '../deps.js';
import { parseIdParam } from './_helpers.js';

/**
 * Global USER memory CRUD — the human-facing surface for the cross-project
 * "who I am / how I want you to work" facts the agent reads on every project.
 *
 * Backed by the LIVE `agent_memory` store (scope 'user', reserved project 0)
 * — the same table `<user-preferences>` injection and `remember({scope:'user'})`
 * read/write. It previously wrote to legacy `snapshots`, which the injector
 * never reads: preferences typed in the UI silently never reached the agent.
 * Response rows keep the panel's `{id,title,content,category,importance}`
 * shape (category mirrors the closed agent-memory `type`).
 */
const USER_PROJECT_ID = 0;

interface PanelRow {
  id: number;
  title: string;
  content: string;
  category: string;
  importance: number;
  created_at: string;
  updated_at: string;
}

function toPanelRow(row: {
  id: number; name: string; content: string; type: string; importance: number;
  created_at: string; updated_at: string;
}): PanelRow {
  return {
    id: row.id,
    title: row.name,
    content: row.content,
    // The closed store type for user-scope facts is 'preference'; the panel
    // renders it with the 'feedback' chip it already knows.
    category: row.type === 'preference' ? 'feedback' : row.type,
    importance: row.importance,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function mountUserMemoryRoutes(app: Hono, deps: ServerDeps): void {
  const writer = new AgentMemoryWriter(deps.db, deps.agentMemoryService);

  app.get('/api/user-memory', (c) =>
    c.json(deps.db.listAgentMemoryLive('user', USER_PROJECT_ID).map(toPanelRow)));

  app.get('/api/user-memory/health', (c) => {
    const all = deps.db.listAgentMemoryLive('user', USER_PROJECT_ID, { includeArchived: true });
    const live = all.filter((r) => r.archived_at === null);
    const byCategory: Record<string, number> = {};
    for (const r of live) byCategory[r.type] = (byCategory[r.type] ?? 0) + 1;
    const bySource: Record<string, number> = {};
    for (const r of live) bySource[r.source] = (bySource[r.source] ?? 0) + 1;
    return c.json({
      memory_enabled: true,
      last: deps.db.latestMemoryDistill(USER_PROJECT_ID),
      recent: deps.db.recentMemoryDistills(USER_PROJECT_ID, 10),
      totals: {
        total: live.length,
        byCategory,
        bySource,
        archived: all.length - live.length,
      },
    });
  });

  app.post('/api/user-memory', async (c) => {
    const body = await c.req.json<{ title: string; content: string; category?: string }>();
    const row = deps.agentMemoryService.create({
      scope: 'user',
      projectId: USER_PROJECT_ID,
      name: body.title,
      type: 'preference',
      content: body.content,
      source: 'manual',
      // Manual entries carry explicit user intent — the feedback-tier floor.
      importance: 0.75,
    });
    await deps.agentMemoryService.embedAndUpsert(row).catch(() => undefined);
    try {
      deps.db.recordAgentMemoryEvent({
        eventType: 'remember', scope: 'user', projectId: USER_PROJECT_ID, memoryId: row.id, kept: 1,
      });
    } catch { /* best-effort */ }
    return c.json(toPanelRow(row), 201);
  });

  app.put('/api/user-memory/:id', async (c) => {
    const id = parseIdParam(c);
    const body = await c.req.json<{ content?: string; importance?: number }>();
    const updated = await writer.update(id, {
      content: body.content,
      importance: body.importance,
    });
    if (!updated) return c.json({ error: 'not found' }, 404);
    return c.json(toPanelRow(updated));
  });

  app.delete('/api/user-memory/:id', async (c) => {
    const id = parseIdParam(c);
    const row = deps.db.getAgentMemoryById(id);
    if (!row) return c.json({ error: 'not found' }, 404);
    deps.agentMemoryService.archive(id, 'forgotten:user');
    await deps.agentMemoryService.removeVectors(row.id, row.project_id).catch(() => undefined);
    try {
      deps.db.recordAgentMemoryEvent({
        eventType: 'forget', scope: 'user', projectId: USER_PROJECT_ID, memoryId: row.id,
      });
    } catch { /* best-effort */ }
    return c.json({ ok: true });
  });
}
