/**
 * Company session archive/reset routes.
 *
 *   POST  /api/company/sessions/:id/reset
 *   GET   /api/company/sessions/:id/archives
 *   GET   /api/company/sessions/:id/archives/:archive_id
 *
 * See plan: "Feature: Resetar Sessão Company + tab Arquivadas".
 *
 * Reset flow:
 *   1. If an orchestrator is alive in memory, abort it (optionally
 *      tearing down the sandbox per request body) and evict from the
 *      registry. Reuses `abortAll({ teardownSandbox, finalStatus:'idle' })`.
 *   2. Persist an archive row + stamp archive_id on all active
 *      agent_runs/board/master_prompts/kanban (via store.archiveCompanySession).
 *   3. Session status comes back as `idle` so the next `/start` works.
 *
 * Archive detail returns a minimal snapshot — board entries, agent runs,
 * and optionally kanban cards. The message history of each agent_run
 * lives in the `coder_messages` table and is loaded on demand via the
 * existing per-session endpoint, keyed by `coder_session_id`.
 */
import type { Hono } from 'hono';
import type { ServerDeps } from '../../deps.js';
import { getCompanyOrchestrator, deleteCompanyOrchestrator } from '../../../sse/companyOrchestrator.js';
import { parseIdParam, parseJsonBody, notFound } from '../_helpers.js';
import {
  appOwnedControlPlaneConflict,
  isAppOwnedCompanySession,
} from './runtime-capabilities.js';

interface ResetBody {
  reason?: string;
  archive_kanban?: boolean;
  teardown_sandbox?: boolean;
}

export function mountCompanyArchiveRoutes(app: Hono, deps: ServerDeps): void {
  const { companyStore } = deps;

  app.post('/api/company/sessions/:id/reset', async (c) => {
    const id = parseIdParam(c);
    const session = companyStore.getCompanySession(id);
    if (!session) return notFound(c);
    if (isAppOwnedCompanySession(companyStore, id)) {
      return appOwnedControlPlaneConflict(c, 'session reset/archive');
    }

    const body = await parseJsonBody<ResetBody>(c).catch(() => ({} as ResetBody));
    const archiveKanban = body.archive_kanban !== false; // default true
    const teardownSandbox = body.teardown_sandbox !== false; // default true

    // Step 1 — evict the live orchestrator, if any. We pass
    // `finalStatus:'idle'` so the abort path doesn't leave the session
    // in `error` — the subsequent DB archive step then flips it to idle
    // officially (abortAll's DB update is best-effort and may race).
    const orchestrator = getCompanyOrchestrator(id);
    if (orchestrator) {
      try {
        orchestrator.abortAll({ teardownSandbox, finalStatus: 'idle' });
      } catch (e) {
        console.warn(
          `[company/reset] abortAll failed for session ${id}:`,
          e instanceof Error ? e.message : String(e),
        );
      }
      deleteCompanyOrchestrator(id);
    }

    // Step 2 — archive active conversation state + idle the session.
    let archive;
    try {
      archive = companyStore.archiveCompanySession(id, {
        reason: body.reason,
        includeKanban: archiveKanban,
        includeSandbox: teardownSandbox,
      });
    } catch (e) {
      return c.json(
        { error: `Archive failed: ${e instanceof Error ? e.message : String(e)}` },
        500,
      );
    }

    return c.json({ archive });
  });

  app.get('/api/company/sessions/:id/archives', (c) => {
    const id = parseIdParam(c);
    const session = companyStore.getCompanySession(id);
    if (!session) return notFound(c);
    return c.json(companyStore.listArchives(id));
  });

  app.get('/api/company/sessions/:id/archives/:archiveId', (c) => {
    const id = parseIdParam(c);
    const archiveId = Number(c.req.param('archiveId'));
    if (!Number.isFinite(archiveId)) {
      return c.json({ error: 'Invalid archiveId' }, 400);
    }
    const archive = companyStore.getArchive(archiveId);
    if (!archive || archive.company_session_id !== id) return notFound(c);

    const agentRuns = companyStore.listArchivedAgentRuns(archiveId);
    const board = companyStore.readArchivedBoard(archiveId);
    const kanban = archive.included_kanban
      ? companyStore.listArchivedKanbanCards(archiveId)
      : [];

    return c.json({
      archive,
      agent_runs: agentRuns,
      board,
      kanban,
      // Index of coder_session_ids — the dashboard opens each one via
      // the existing coder-session-detail endpoint to render messages.
      conversations_index: agentRuns.map((r) => ({
        agent_run_id: r.id,
        role: r.role,
        coder_session_id: r.coder_session_id,
        provider: r.provider,
        model: r.model,
        status: r.status,
      })),
    });
  });
}
