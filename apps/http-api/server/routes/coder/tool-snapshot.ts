import type { Hono } from 'hono';
import type { ServerDeps } from '../../deps.js';
import type { SessionId } from '@mcp/session-storage';
import { toolSnapshotDiff, toolSnapshotSummary } from '@mcp/services/services/tool-session-snapshots.js';
import { notFound, parseSessionIdParam } from '../_helpers.js';

export function mountToolSnapshotRoutes(app: Hono, store: ServerDeps['sessionStore'],
  companyChildren?: (id: string) => Promise<SessionId[]>): void {
  const scope = companyChildren ? 'company' : 'coder';
  const base = `/api/${scope}/sessions/:id/snapshot/tool/:toolUseId`;
  const load = async (id: SessionId, toolUseId: string) => {
    const ids = companyChildren ? await companyChildren(id) : [id];
    const matches = (await Promise.all(ids.map(child => store.listToolSnapshots?.('coder', child, toolUseId) ?? [])))
      .filter(rows => rows.length > 0);
    // Tool ids are scoped to a coder session. Never guess if two children reused one.
    return matches.length === 1 ? matches[0]! : [];
  };
  app.get(base, async c => {
    const id = parseSessionIdParam(c);
    if (!companyChildren && !await store.getSession(id)) return notFound(c, 'session not found');
    const rows = await load(id, c.req.param('toolUseId') ?? '');
    return c.json({ files: rows.map(toolSnapshotSummary) });
  });
  app.get(`${base}/file/:index/diff`, async c => {
    const id = parseSessionIdParam(c);
    if (!companyChildren && !await store.getSession(id)) return notFound(c, 'session not found');
    const index = Number(c.req.param('index'));
    if (!Number.isSafeInteger(index) || index < 0) return notFound(c, 'snapshot file not found');
    const rows = await load(id, c.req.param('toolUseId') ?? '');
    const row = rows[index];
    if (!row) return notFound(c, 'snapshot file not found');
    return c.json(toolSnapshotDiff(row, {
      context: Number(c.req.query('context') ?? 3),
      contextBefore: Number(c.req.query('contextBefore') ?? c.req.query('context') ?? 3),
      contextAfter: Number(c.req.query('contextAfter') ?? c.req.query('context') ?? 3),
    }));
  });
}
