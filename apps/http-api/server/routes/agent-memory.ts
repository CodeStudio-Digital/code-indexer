import type { Hono } from 'hono';
import type { ServerDeps } from '../deps.js';
import { parseIdParam, parseIntQuery, notFound } from './_helpers.js';
import { memoryPage, mountAgentMemoryCurationRoutes } from './agent-memory-curation.js';
import { mountAgentMemorySemanticRoutes } from './agent-memory-semantic.js';
import { mountAgentMemoryEvolutionRoutes } from './agent-memory-evolution.js';
import { searchProjectMemory } from '../index-search-service.js';

/**
 * Agent-memory curation — the human feedback loop over the LIVE store
 * (`agent_memory`): list (with archived tail), pin/unpin (importance),
 * one-click reversible archive, restore. Pin/forget land in
 * `agent_memory_events` so curation feeds the effectiveness KPIs.
 * Convention: pin = importance 0.95 (PIN_THRESHOLD 0.9 — same as snapshots).
 */
export function mountAgentMemoryRoutes(app: Hono, deps: ServerDeps): void {
  const { db, agentMemoryService } = deps;
  mountAgentMemoryCurationRoutes(app, deps);
  mountAgentMemorySemanticRoutes(app, deps);
  mountAgentMemoryEvolutionRoutes(app, deps);

  /** Query endpoint for out-of-process agents. The http-api process owns the
   * memory embedder and vector worker; callers never open sqlite-vec. The
   * service itself preserves FTS results when semantic retrieval is offline. */
  app.get('/api/projects/:id/agent-memory/search', async (c) => {
    const projectId = parseIdParam(c);
    const outcome = await searchProjectMemory(deps, projectId, c.req.query('q') ?? '', parseIntQuery(c, 'limit', 5), c.req.raw.signal);
    if (outcome.status !== 200) return outcome.status === 404 ? notFound(c) : c.json({ error: outcome.error }, 400);
    const { results } = outcome;
    if (c.req.query('projection') === 'ids') return c.json({ results: results.map(row => ({ id: row.id, score: row.score })) });
    return c.json({ results });
  });

  app.get('/api/projects/:id/agent-memory', (c) => {
    const projectId = parseIdParam(c);
    const project = db.getProject(projectId);
    if (!project) return notFound(c);
    const scope = projectId === 0 ? 'user' : 'project';
    if (c.req.query('limit') !== undefined || c.req.query('offset') !== undefined) {
      return c.json(memoryPage(deps, projectId, { offset: parseIntQuery(c, 'offset', 0), limit: parseIntQuery(c, 'limit', 40),
        archived: c.req.query('archived') === 'true', query: c.req.query('q') }));
    }
    // Compatibility for older clients. Current UI requests bounded pages.
    return c.json(db.listAgentMemoryLive(scope, projectId, { includeArchived: true }));
  });

  app.put('/api/agent-memory/:id/importance', async (c) => {
    const id = parseIdParam(c);
    const row = db.getAgentMemoryById(id);
    if (!row) return notFound(c);
    if (row.archived_at) return c.json({ error: 'Memory is archived; reload before pinning.' }, 409);
    const body = await c.req.json<{ importance: number }>();
    const importance = Math.max(0, Math.min(1, Number(body.importance)));
    if (!Number.isFinite(importance)) return c.json({ error: 'importance must be 0..1' }, 400);
    await agentMemoryService.runRelationalWrite(() => db.setAgentMemoryImportance(id, importance));
    try {
      db.recordAgentMemoryEvent({
        eventType: 'pin', scope: row.scope, projectId: row.project_id, memoryId: id,
        meta: { importance },
      });
    } catch { /* best-effort */ }
    return c.json({ ok: true, importance });
  });

  app.post('/api/agent-memory/:id/archive', async (c) => {
    const id = parseIdParam(c);
    const row = db.getAgentMemoryById(id);
    if (!row) return notFound(c);
    if (row.archived_at) return c.json({ ok: true, alreadyArchived: true });
    await agentMemoryService.runRelationalWrite(() => agentMemoryService.archive(id, 'forgotten:user'));
    try {
      db.recordAgentMemoryEvent({
        eventType: 'forget', scope: row.scope, projectId: row.project_id, memoryId: id,
      });
    } catch { /* best-effort */ }
    return c.json({ ok: true });
  });

  app.post('/api/agent-memory/:id/restore', async (c) => {
    const id = parseIdParam(c);
    const row = await agentMemoryService.runRelationalWrite(() => db.transaction(() => {
      const restored = agentMemoryService.restore(id);
      // Human restoration is an explicit decision. Automatic maintenance must
      // not immediately archive the same version again.
      if (restored) db.raw().prepare("UPDATE agent_memory SET source='manual' WHERE id=?").run(id);
      return restored;
    }));
    if (!row) {
      return c.json({ ok: false, error: 'not restorable (unknown, live, or a live row holds the same name)' }, 409);
    }
    try {
      db.recordAgentMemoryEvent({
        eventType: 'restore', scope: row.scope, projectId: row.project_id, memoryId: id,
      });
    } catch { /* best-effort */ }
    return c.json({ ok: true });
  });
}
