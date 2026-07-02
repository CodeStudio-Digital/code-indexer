import type { Hono } from 'hono';
import type { ServerDeps } from '../deps.js';
import { parseIdParam, notFound } from './_helpers.js';

/**
 * Agent-memory curation — the human feedback loop over the LIVE store
 * (`agent_memory`): list (with archived tail), pin/unpin (importance),
 * one-click reversible archive, restore. Pin/forget land in
 * `agent_memory_events` so curation feeds the effectiveness KPIs.
 * Convention: pin = importance 0.95 (PIN_THRESHOLD 0.9 — same as snapshots).
 */
export function mountAgentMemoryRoutes(app: Hono, deps: ServerDeps): void {
  const { db, agentMemoryService } = deps;

  app.get('/api/projects/:id/agent-memory', (c) => {
    const projectId = parseIdParam(c);
    const project = db.getProject(projectId);
    if (!project) return notFound(c);
    const scope = projectId === 0 ? 'user' : 'project';
    return c.json(db.listAgentMemoryLive(scope, projectId, { includeArchived: true }));
  });

  app.put('/api/agent-memory/:id/importance', async (c) => {
    const id = parseIdParam(c);
    const row = db.getAgentMemoryById(id);
    if (!row) return notFound(c);
    const body = await c.req.json<{ importance: number }>();
    const importance = Math.max(0, Math.min(1, Number(body.importance)));
    if (!Number.isFinite(importance)) return c.json({ error: 'importance must be 0..1' }, 400);
    db.setAgentMemoryImportance(id, importance);
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
    db.archiveAgentMemory(id, 'forgotten:user');
    await agentMemoryService.removeVectors(row.id, row.project_id).catch(() => undefined);
    try {
      db.recordAgentMemoryEvent({
        eventType: 'forget', scope: row.scope, projectId: row.project_id, memoryId: id,
      });
    } catch { /* best-effort */ }
    return c.json({ ok: true });
  });

  app.post('/api/agent-memory/:id/restore', async (c) => {
    const id = parseIdParam(c);
    const restored = db.restoreAgentMemory(id);
    if (!restored) {
      return c.json({ ok: false, error: 'not restorable (unknown, live, or a live row holds the same name)' }, 409);
    }
    const row = db.getAgentMemoryById(id);
    if (row) await agentMemoryService.embedAndUpsert(row).catch(() => undefined);
    try {
      db.recordAgentMemoryEvent({
        eventType: 'restore', scope: row?.scope, projectId: row?.project_id, memoryId: id,
      });
    } catch { /* best-effort */ }
    return c.json({ ok: true });
  });
}
