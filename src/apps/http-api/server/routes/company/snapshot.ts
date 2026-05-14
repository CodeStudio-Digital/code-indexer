/**
 * Company-session snapshot routes.
 *
 * Snapshots are recorded per-runner (each `runCoder` call is a unique
 * `coder_sessions.id`), so the company view aggregates across every
 * coder session that belongs to a `company_sessions.id`. This includes
 * the master and all subordinate agent runs from `company_agent_runs`.
 *
 * Mounted at `/api/company/sessions/:id/snapshot/*`. Mirrors the coder
 * snapshot API surface so the dashboard component is interchangeable.
 */
import type { Hono } from 'hono';
import type { ServerDeps } from '../../deps.js';
import { parseIdParam, parseJsonBody, notFound } from '../_helpers.js';
import { SessionFileSnapshotStore } from '../../../../../store/session-file-snapshot-store.js';
import { SessionSnapshotService, type FileSummary } from '../../../../../core/services/session-snapshots.js';

interface AgentRunRow {
  coder_session_id: number | null;
}

function listCoderSessionIdsForCompany(
  db: import('better-sqlite3').Database,
  companySessionId: number,
): number[] {
  // The master session itself is a coder_session, and so are all spawned
  // subordinates (via company_agent_runs.coder_session_id). We union those.
  const rows = db
    .prepare(
      `SELECT coder_session_id FROM company_agent_runs
       WHERE company_session_id = ? AND coder_session_id IS NOT NULL`,
    )
    .all(companySessionId) as AgentRunRow[];
  const ids = new Set<number>();
  for (const r of rows) if (r.coder_session_id != null) ids.add(r.coder_session_id);
  // Also include the master's direct coder session if tracked on the company row.
  const masterRow = db
    .prepare('SELECT master_session_id FROM company_sessions WHERE id = ?')
    .get(companySessionId) as { master_session_id: number | null } | undefined;
  if (masterRow?.master_session_id != null) ids.add(masterRow.master_session_id);
  return Array.from(ids);
}

export function mountCompanySnapshotRoutes(app: Hono, deps: ServerDeps): void {
  const { sessionStore, db } = deps;
  const snapshotStore = new SessionFileSnapshotStore(sessionStore.getDb());
  const service = new SessionSnapshotService(snapshotStore, (kind, sessionId) => {
    if (kind !== 'coder') return null;
    const s = sessionStore.getSession(sessionId);
    if (!s) return null;
    const p = db.getProject(s.project_id);
    return p?.root_path ?? null;
  });

  app.get('/api/company/sessions/:id/snapshot', async (c) => {
    const companySessionId = parseIdParam(c);
    if (!Number.isFinite(companySessionId)) return c.json({ error: 'bad id' }, 400);
    const includeClosed = c.req.query('includeClosed') === '1';
    const coderIds = listCoderSessionIdsForCompany(sessionStore.getDb(), companySessionId);
    const allFiles: FileSummary[] = [];
    for (const coderId of coderIds) {
      const files = await service.listFiles('coder', coderId, { includeClosed });
      allFiles.push(...files);
    }
    return c.json({ files: allFiles });
  });

  app.get('/api/company/sessions/:id/snapshot/file/:baselineId/diff', async (c) => {
    const baselineId = parseIdParam(c, 'baselineId');
    const diff = await service.getDiff(baselineId);
    if (!diff) return notFound(c, 'baseline not found');
    return c.json(diff);
  });

  app.post('/api/company/sessions/:id/snapshot/file/:baselineId/accept-hunk', async (c) => {
    const baselineId = parseIdParam(c, 'baselineId');
    const body = await parseJsonBody<{ fingerprint: string }>(c);
    if (!body.fingerprint) return c.json({ error: 'fingerprint required' }, 400);
    const r = await service.acceptHunk(baselineId, body.fingerprint);
    return c.json(r);
  });

  app.post('/api/company/sessions/:id/snapshot/file/:baselineId/revert-hunk', async (c) => {
    const baselineId = parseIdParam(c, 'baselineId');
    const body = await parseJsonBody<{ fingerprint: string }>(c);
    if (!body.fingerprint) return c.json({ error: 'fingerprint required' }, 400);
    const r = await service.revertHunk(baselineId, body.fingerprint);
    return c.json(r);
  });

  app.post('/api/company/sessions/:id/snapshot/file/:baselineId/accept', async (c) => {
    const baselineId = parseIdParam(c, 'baselineId');
    const r = await service.acceptFile(baselineId);
    return c.json(r);
  });

  app.post('/api/company/sessions/:id/snapshot/file/:baselineId/revert', async (c) => {
    const baselineId = parseIdParam(c, 'baselineId');
    const r = await service.revertFile(baselineId);
    return c.json(r);
  });

  app.post('/api/company/sessions/:id/snapshot/accept-all', async (c) => {
    const companySessionId = parseIdParam(c);
    const coderIds = listCoderSessionIdsForCompany(sessionStore.getDb(), companySessionId);
    let closed = 0;
    for (const coderId of coderIds) {
      const r = await service.acceptAll('coder', coderId);
      closed += r.closed;
    }
    return c.json({ closed });
  });

  app.post('/api/company/sessions/:id/snapshot/revert-all', async (c) => {
    const companySessionId = parseIdParam(c);
    const body = await parseJsonBody<{ confirm: boolean }>(c);
    if (!body.confirm) return c.json({ error: 'confirm required' }, 400);
    const coderIds = listCoderSessionIdsForCompany(sessionStore.getDb(), companySessionId);
    let closed = 0;
    for (const coderId of coderIds) {
      const r = await service.revertAll('coder', coderId);
      closed += r.closed;
    }
    return c.json({ closed });
  });
}
