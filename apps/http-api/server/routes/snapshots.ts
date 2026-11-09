import type { Context, Hono } from 'hono';
import { createSnapshotsHandlers, createContext } from '@mcp/api-handlers';
import { ApiError } from '@mcp/api-bus';
import type { SnapshotCategory } from '@mcp/shared/types.js';
import type { ServerDeps } from '../deps.js';
import { parseIdParam } from './_helpers.js';
import { getMemoryConsolidator } from '../../sse/memory-consolidator.js';
import { memoryCurationTotals } from '@mcp/store/db/agent-memory-curation.js';

function mapApiError(c: Context, err: unknown) {
  if (err instanceof ApiError) {
    return c.json({ error: err.message, code: err.code }, err.status as never);
  }
  throw err;
}

export function mountSnapshotsRoutes(app: Hono, deps: ServerDeps): void {
  const h = createSnapshotsHandlers(deps);

  app.get('/api/projects/:id/snapshots', async (c) => {
    try {
      const category = c.req.query('category') as SnapshotCategory | undefined;
      return c.json(await h.list({ projectId: parseIdParam(c), category }, createContext()));
    } catch (err) {
      return mapApiError(c, err);
    }
  });

  app.post('/api/projects/:id/snapshots', async (c) => {
    try {
      const projectId = parseIdParam(c);
      const body = await c.req.json<{
        title: string;
        category: SnapshotCategory;
        content: string;
        tags?: string[];
      }>();
      return c.json(await h.create({ projectId, ...body }, createContext()), 201);
    } catch (err) {
      return mapApiError(c, err);
    }
  });

  app.put('/api/snapshots/:id', async (c) => {
    try {
      const body = await c.req.json<{
        title?: string;
        category?: SnapshotCategory;
        content?: string;
        tags?: string[];
        importance?: number;
      }>();
      return c.json(await h.update({ id: parseIdParam(c), ...body }, createContext()));
    } catch (err) {
      return mapApiError(c, err);
    }
  });

  // Current memory stock. Historical distillation logs remain explicitly
  // labelled diagnostics; they are not evidence that a row was injected.
  app.get('/api/projects/:id/memory/health', (c) => {
    const projectId = parseIdParam(c);
    const project = deps.db.getProject(projectId);
    if (!project) return c.json({ error: 'project not found' }, 404);
    return c.json({
      memory_enabled: deps.db.getProjectMemoryEnabled(projectId),
      last: deps.db.latestMemoryDistill(projectId),
      recent: deps.db.recentMemoryDistills(projectId, 10),
      store: 'agent_memory',
      diagnostics_source: 'historical_distill_log',
      totals: memoryCurationTotals(deps.db.raw(), projectId === 0 ? 'user' : 'project', projectId),
    });
  });

  // Archived snapshots (the reversible GC bin) — feeds the "Restore" dialog.
  app.get('/api/projects/:id/snapshots/archived', (c) => {
    const projectId = parseIdParam(c);
    if (!deps.db.getProject(projectId)) return c.json({ error: 'project not found' }, 404);
    const limit = Math.min(Number(c.req.query('limit') ?? 50) || 50, 200);
    return c.json({ archived: deps.db.listArchivedSnapshots(projectId, limit) });
  });

  // Restore an archived snapshot. Clears its embedding hash so the backfill
  // re-embeds it (vectors were dropped on archive). Reverses a consolidation GC.
  app.post('/api/snapshots/:id/unarchive', (c) => {
    const id = parseIdParam(c);
    deps.snapshotService.unarchive(id);
    return c.json({ ok: true });
  });

  // Manual "run now" for the memory consolidator — merges near-duplicates and
  // GCs stale/cold/low-importance snapshots for this project on demand. Works
  // even when the periodic timer is disarmed (MCP_MEMORY_CONSOLIDATE off).
  app.post('/api/projects/:id/memory/consolidate', async (c) => {
    const projectId = parseIdParam(c);
    if (!deps.db.getProject(projectId)) return c.json({ error: 'project not found' }, 404);
    const consolidator = getMemoryConsolidator();
    if (!consolidator) return c.json({ error: 'consolidator not available' }, 503);
    const results = await consolidator.runOnce(projectId);
    return c.json({ results });
  });

  app.delete('/api/snapshots/:id', async (c) => {
    try {
      return c.json(await h.delete({ id: parseIdParam(c) }, createContext()));
    } catch (err) {
      return mapApiError(c, err);
    }
  });

  app.get('/api/projects/:id/context', async (c) => {
    try {
      return c.text(await h.getForContext({ projectId: parseIdParam(c) }, createContext()));
    } catch (err) {
      return mapApiError(c, err);
    }
  });

  app.get('/api/snapshots/:id/history', async (c) => {
    try {
      return c.json(await h.history({ id: parseIdParam(c) }, createContext()));
    } catch (err) {
      return mapApiError(c, err);
    }
  });
}
