import type { Hono } from 'hono';
import { z } from 'zod';
import { listLegacyMemoryPage, listMemoryCurationPage } from '@mcp/store/db/agent-memory-curation.js';
import { importLegacyMemories } from '@mcp/services/memory/legacy-memory-import.js';
import type { ServerDeps } from '../deps.js';
import { notFound, parseIdParam, parseIntQuery } from './_helpers.js';

const memoryInput = z.object({
  name: z.string().trim().min(1).max(240), description: z.string().trim().max(500).optional(),
  type: z.enum(['preference', 'convention', 'procedure', 'architecture', 'gotcha', 'external_pointer', 'pattern', 'decision', 'note']),
  content: z.string().trim().min(1).max(100_000), importance: z.number().min(0).max(1).optional(),
});
const editInput = memoryInput.partial().refine(value => Object.keys(value).length > 0, 'No changes supplied');

export function memoryPage(deps: ServerDeps, projectId: number,
  options: Parameters<typeof listMemoryCurationPage>[3]) {
  return listMemoryCurationPage(deps.db.raw(), projectId === 0 ? 'user' : 'project', projectId, options);
}

/** Human curation uses the same fenced store as recall. No direct model call. */
export function mountAgentMemoryCurationRoutes(app: Hono, deps: ServerDeps): void {
  const { db, agentMemoryService: service } = deps;
  app.post('/api/projects/:id/agent-memory', async c => {
    const projectId = parseIdParam(c);
    if (!db.getProject(projectId)) return notFound(c);
    const parsed = memoryInput.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? 'Invalid memory' }, 400);
    const row = await service.runRelationalWrite(() => db.transaction(() => {
      const created = service.create({ ...parsed.data,
        scope: projectId === 0 ? 'user' : 'project', projectId, source: 'manual', importance: parsed.data.importance ?? 0.75 });
      db.recordAgentMemoryEvent({ eventType: 'remember', scope: created.scope, projectId, memoryId: created.id, kept: 1,
        meta: { source: 'curation' } });
      return created;
    }));
    return c.json(row, 201);
  });

  app.get('/api/agent-memory/:id', c => {
    const row = db.getAgentMemoryById(parseIdParam(c));
    return row ? c.json(row) : notFound(c);
  });

  app.put('/api/agent-memory/:id', async c => {
    const id = parseIdParam(c);
    const parsed = editInput.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? 'Invalid memory' }, 400);
    const result = await service.runRelationalWrite(() => db.transaction(() => {
      const old = db.getAgentMemoryById(id);
      if (!old) return { kind: 'missing' as const };
      if (old.archived_at) return { kind: 'archived' as const };
      const patch = parsed.data;
      if (Object.entries(patch).every(([key, value]) => old[key as keyof typeof old] === value)) {
        return { kind: 'saved' as const, row: old };
      }
      const refs = JSON.parse(old.referenced_files ?? '[]') as Array<string | { path: string; hash: string | null }>;
      const row = service.replace(id, { name: patch.name ?? old.name, description: patch.description ?? old.description,
        type: patch.type ?? old.type, content: patch.content ?? old.content, importance: patch.importance ?? old.importance,
        scope: old.scope, projectId: old.project_id, source: 'manual', sourceSnapshotId: old.source_snapshot_id,
        sync: old.sync === 1, referencedFileSnapshots: refs.map(ref => typeof ref === 'string' ? { path: ref, hash: null } : ref) });
      db.recordAgentMemoryEvent({ eventType: 'remember', scope: row.scope, projectId: row.project_id, memoryId: row.id,
        kept: 1, meta: { source: 'curation', replaces: id } });
      return { kind: 'saved' as const, row };
    }));
    if (result.kind === 'missing') return notFound(c);
    if (result.kind === 'archived') return c.json({ error: 'This memory changed or was archived. Reload before editing.' }, 409);
    return c.json(result.row);
  });

  app.get('/api/projects/:id/agent-memory/legacy', c => {
    const projectId = parseIdParam(c);
    if (!db.getProject(projectId)) return notFound(c);
    return c.json(listLegacyMemoryPage(db.raw(), projectId, parseIntQuery(c, 'offset', 0), parseIntQuery(c, 'limit', 40)));
  });

  app.get('/api/projects/:id/agent-memory/legacy/:snapshotId', c => {
    const projectId = parseIdParam(c);
    const snapshot = db.getSnapshotById(Number(c.req.param('snapshotId')));
    if (!snapshot || snapshot.project_id !== projectId) return notFound(c);
    return c.json({ ...snapshot, referenced_files: db.getSnapshotFiles(snapshot.id),
      history: db.getSnapshotHistory(snapshot.id) });
  });

  app.post('/api/projects/:id/agent-memory/legacy/import', async c => {
    const projectId = parseIdParam(c);
    if (!db.getProject(projectId)) return notFound(c);
    const parsed = z.object({ snapshotIds: z.array(z.number().int().positive()).min(1).max(100) })
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'Choose between 1 and 100 legacy notes.' }, 400);
    return c.json(await importLegacyMemories(db, service, projectId, parsed.data.snapshotIds, c.req.raw.signal));
  });
}
