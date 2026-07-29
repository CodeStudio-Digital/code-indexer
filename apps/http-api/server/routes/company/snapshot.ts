/**
 * Company-session snapshot routes.
 *
 * Snapshots are recorded per filesystem coder bundle, so the Company view
 * aggregates every child session linked to the Company bundle. This includes
 * the master and all subordinate agent-run entities.
 *
 * Mounted at `/api/company/sessions/:id/snapshot/*`. Mirrors the coder
 * snapshot API surface so the dashboard component is interchangeable.
 */
import type { Hono } from 'hono';
import type { ServerDeps } from '../../deps.js';
import {
  parseCompanySessionIdParam,
  parseJsonBody,
  parseSessionRecordIdParam,
  notFound,
} from '../_helpers.js';
import { SessionSnapshotService, type FileSummary } from '@mcp/services/services/session-snapshots.js';
import { mountSnapshotReviewRoutes } from '../snapshot-review-routes.js';
import { isMutationOutcomeUnknownError } from '@mcp/orchestrator-host';
import {
  asCompanySessionId,
  type SessionId,
} from '@mcp/session-storage';
import {
  evictCompanyOrchestrator,
  getCompanyOrchestrator,
} from '../../../sse/companyOrchestrator.js';

async function listCoderSessionIdsForCompany(
  sessionStore: ServerDeps['sessionStore'],
  companySessionId: string,
): Promise<SessionId[]> {
  await sessionStore.refresh();
  return sessionStore.catalog
    .list()
    .filter((entry) => {
      if (entry.session.kind !== 'coder') return false;
      const metadata = entry.session.metadata;
      return (
        entry.session.parent_session_id === companySessionId ||
        metadata.company_session_id === companySessionId ||
        metadata.companySessionId === companySessionId ||
        metadata.group_id === companySessionId
      );
    })
    .map((entry) => entry.session.id);
}

export function mountCompanySnapshotRoutes(app: Hono, deps: ServerDeps): void {
  const { sessionStore, db } = deps;
  const snapshotStore = sessionStore;
  const service = new SessionSnapshotService(snapshotStore, async (kind, sessionId) => {
    if (kind !== 'coder') return null;
    const s = await sessionStore.getSession(sessionId);
    if (!s || s.project_id == null) return null;
    const p = db.getProject(s.project_id);
    return p?.root_path ?? null;
  });

  app.get('/api/company/sessions/:id/snapshot', async (c) => {
    const companySessionId = parseCompanySessionIdParam(c);
    const includeClosed = c.req.query('includeClosed') === '1';
    const coderIds = await listCoderSessionIdsForCompany(
      sessionStore,
      companySessionId,
    );
    // Enrich each file with `projectId` + `projectName` so the dashboard
    // can group / filter by project. Without this, files from agents
    // running in different projects of the same company collide in the
    // UI (same `filePath`, no way to tell them apart). Lookup is per
    // coder bundle: each session projection has one owning project.
    const allFiles: Array<FileSummary<string> & {
      projectId: number | null;
      projectName: string | null;
    }> = [];
    for (const coderId of coderIds) {
      const session = await sessionStore.getSession(coderId);
      const project =
        session?.project_id != null
          ? db.getProject(session.project_id)
          : null;
      const files = await service.listFiles('coder', coderId, { includeClosed });
      for (const f of files) {
        allFiles.push({
          ...f,
          projectId: project?.id ?? null,
          projectName: project?.name ?? null,
        });
      }
    }
    return c.json({ files: allFiles });
  });

  app.get('/api/company/sessions/:id/snapshot/file/:baselineId/diff', async (c) => {
    parseCompanySessionIdParam(c);
    const baselineId = parseSessionRecordIdParam(c, 'baselineId');
    const context = Number(c.req.query('context') ?? 3);
    const contextBeforeRaw = c.req.query('contextBefore');
    const contextAfterRaw = c.req.query('contextAfter');
    const diff = await service.getDiff(baselineId, {
      context: Number.isFinite(context) ? context : 3,
      contextBefore: contextBeforeRaw ? Number(contextBeforeRaw) : undefined,
      contextAfter: contextAfterRaw ? Number(contextAfterRaw) : undefined,
    });
    if (!diff) return notFound(c, 'baseline not found');
    return c.json(diff);
  });

  app.post('/api/company/sessions/:id/snapshot/file/:baselineId/accept-hunk', async (c) => {
    parseCompanySessionIdParam(c);
    const baselineId = parseSessionRecordIdParam(c, 'baselineId');
    const body = await parseJsonBody<{ fingerprint: string }>(c);
    if (!body.fingerprint) return c.json({ error: 'fingerprint required' }, 400);
    const r = await service.acceptHunk(baselineId, body.fingerprint);
    return c.json(r);
  });

  app.post('/api/company/sessions/:id/snapshot/file/:baselineId/revert-hunk', async (c) => {
    parseCompanySessionIdParam(c);
    const baselineId = parseSessionRecordIdParam(c, 'baselineId');
    const body = await parseJsonBody<{ fingerprint: string }>(c);
    if (!body.fingerprint) return c.json({ error: 'fingerprint required' }, 400);
    const r = await service.revertHunk(baselineId, body.fingerprint);
    return c.json(r);
  });

  app.post('/api/company/sessions/:id/snapshot/file/:baselineId/accept', async (c) => {
    parseCompanySessionIdParam(c);
    const baselineId = parseSessionRecordIdParam(c, 'baselineId');
    const r = await service.acceptFile(baselineId);
    return c.json(r);
  });

  app.post('/api/company/sessions/:id/snapshot/file/:baselineId/revert', async (c) => {
    parseCompanySessionIdParam(c);
    const baselineId = parseSessionRecordIdParam(c, 'baselineId');
    const r = await service.revertFile(baselineId);
    return c.json(r);
  });

  app.post('/api/company/sessions/:id/snapshot/accept-all', async (c) => {
    const companySessionId = parseCompanySessionIdParam(c);
    const coderIds = await listCoderSessionIdsForCompany(
      sessionStore,
      companySessionId,
    );
    let closed = 0;
    for (const coderId of coderIds) {
      const r = await service.acceptAll('coder', coderId);
      closed += r.closed;
    }
    return c.json({ closed });
  });

  app.post('/api/company/sessions/:id/snapshot/revert-all', async (c) => {
    const companySessionId = parseCompanySessionIdParam(c);
    const body = await parseJsonBody<{ confirm: boolean }>(c);
    if (!body.confirm) return c.json({ error: 'confirm required' }, 400);
    const coderIds = await listCoderSessionIdsForCompany(
      sessionStore,
      companySessionId,
    );
    let closed = 0;
    for (const coderId of coderIds) {
      const r = await service.revertAll('coder', coderId);
      closed += r.closed;
    }
    return c.json({ closed });
  });

  mountSnapshotReviewRoutes(app, deps, {
    scope: 'company',
    listCoderSessionIds: (companySessionId) =>
      listCoderSessionIdsForCompany(sessionStore, companySessionId),
    // Organizational reviews route to the MASTER (same channel as
    // POST /api/company/sessions/:id/message); the master then decides to
    // fix directly or forward to subordinates via the inbox. `{ ok: false }`
    // when no worker is spawned so the UI can flag a non-delivery.
    deliverMessage: async (sessionId, message) => {
      const companySessionId = asCompanySessionId(sessionId);
      const orchestrator = getCompanyOrchestrator(companySessionId);
      if (!orchestrator) return { ok: false };
      try {
        return await orchestrator.sendMessageToMaster(message);
      } catch (error) {
        if (!isMutationOutcomeUnknownError(error)) throw error;
        // The worker may have accepted the review message before its ACK was
        // lost. Fence the stale handle and surface uncertainty; never replay
        // this mutating RPC automatically on a replacement worker.
        await evictCompanyOrchestrator(companySessionId);
        return {
          ok: false,
          code: 'OUTCOME_UNKNOWN',
          error:
            'Review delivery outcome is unknown because its worker acknowledgement ' +
            'was lost; the message was not replayed.',
        };
      }
    },
  });
}
