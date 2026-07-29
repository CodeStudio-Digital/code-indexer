import type { Hono } from 'hono';
import type { ServerDeps } from '../../deps.js';
import { isMutationOutcomeUnknownError } from '@mcp/orchestrator-host';
import {
  evictCompanyOrchestrator,
  getCompanyOrchestrator,
  getOrSpawnCompanyOrchestrator,
} from '../../../sse/companyOrchestrator.js';
import {
  parseCompanySessionIdParam,
  parseJsonBody,
  parseSessionRecordIdParam,
  notFound,
} from '../_helpers.js';
import { appOwnedControlPlaneConflict } from './runtime-capabilities.js';
import { CompanySessionFiles } from '@mcp/company/services/CompanySessionFiles.js';

/**
 * Per-agent (subordinate) control: pause, resume, delete. The session-wide
 * abort lives in `stream.ts`; these act on one independent agent-run file.
 * The Master is intentionally excluded — it's driven by the session
 * abort / delete flows, not these fine-grained controls.
 *
 * NOTE: orchestrator methods are RPC-forwarded to the worker thread, so
 * every call returns a Promise even though `CompanyOrchestrator`'s
 * signatures look synchronous — hence the `await`s below.
 */
export function mountCompanyAgentControlRoutes(app: Hono, deps: ServerDeps): void {
  const { sessionStore } = deps;

  const filesFor = async (
    id: ReturnType<typeof parseCompanySessionIdParam>,
  ): Promise<CompanySessionFiles> => {
    await sessionStore.ensureCatalog();
    return new CompanySessionFiles({ companySessionId: id, sessionStore });
  };

  /**
   * Pause a running subordinate. Stops its current turn but keeps the
   * session so it can be resumed; status becomes `paused`.
   */
  app.post('/api/company/sessions/:id/agents/:agentRunId/pause', async (c) => {
    const id = parseCompanySessionIdParam(c);
    const files = await filesFor(id);
    if (files.getSession().runtime_kind === 'app_studio') {
      return appOwnedControlPlaneConflict(c, 'agent pause');
    }
    const agentRunId = parseSessionRecordIdParam(c, 'agentRunId');
    const run = files.getAgentRunSync(agentRunId);
    if (!run || run.company_session_id !== id) return notFound(c, 'Agent run not found');
    if (run.role === 'master') return c.json({ error: 'Cannot pause the master agent' }, 400);

    const orchestrator = getCompanyOrchestrator(id);
    if (!orchestrator) return c.json({ error: 'No active orchestrator' }, 404);

    let ok: boolean;
    try {
      ok = await orchestrator.pauseSubordinate(agentRunId);
    } catch (error) {
      if (isMutationOutcomeUnknownError(error)) {
        await evictCompanyOrchestrator(id);
        return c.json({
          error: 'Agent pause outcome is unknown because the worker acknowledgement was lost.',
          code: 'OUTCOME_UNKNOWN',
        }, 500);
      }
      throw error;
    }
    if (!ok) return c.json({ error: 'Agent is not running' }, 409);
    return c.json({ ok: true });
  });

  /**
   * Resume a paused / stopped subordinate. Revives the worker if it was
   * evicted (idle TTL). Optional `{ message, thinking }` steers the
   * continuation; defaults to a generic "continue" prompt.
   */
  app.post('/api/company/sessions/:id/agents/:agentRunId/resume', async (c) => {
    const id = parseCompanySessionIdParam(c);
    const files = await filesFor(id);
    if (files.getSession().runtime_kind === 'app_studio') {
      return appOwnedControlPlaneConflict(c, 'agent resume');
    }
    const agentRunId = parseSessionRecordIdParam(c, 'agentRunId');
    const run = files.getAgentRunSync(agentRunId);
    if (!run || run.company_session_id !== id) return notFound(c, 'Agent run not found');
    if (run.role === 'master') return c.json({ error: 'Cannot resume the master agent' }, 400);

    const body = await parseJsonBody<{ message?: string; thinking?: boolean }>(c);
    const { orchestrator } = await getOrSpawnCompanyOrchestrator(id);
    let ok: boolean;
    try {
      ok = await orchestrator.reactivateSubordinate(
        agentRunId,
        body.message?.trim() || 'Continue de onde parou.',
        undefined,
        body.thinking,
      );
    } catch (error) {
      if (isMutationOutcomeUnknownError(error)) {
        await evictCompanyOrchestrator(id);
        return c.json({
          error:
            'Agent resume outcome is unknown because its worker acknowledgement ' +
            'was lost; the continuation was not replayed.',
          code: 'OUTCOME_UNKNOWN',
        }, 500);
      }
      throw error;
    }
    if (!ok) return c.json({ error: 'Agent is not in a resumable state' }, 409);
    return c.json({ ok: true });
  });

  /**
   * Delete a subordinate: abort it if a worker is live (best-effort), then
   * move its independent agent-run record to the bundle trash.
   */
  app.delete('/api/company/sessions/:id/agents/:agentRunId', async (c) => {
    const id = parseCompanySessionIdParam(c);
    const files = await filesFor(id);
    if (files.getSession().runtime_kind === 'app_studio') {
      return appOwnedControlPlaneConflict(c, 'agent deletion');
    }
    const agentRunId = parseSessionRecordIdParam(c, 'agentRunId');
    const run = files.getAgentRunSync(agentRunId);
    if (!run || run.company_session_id !== id) return notFound(c, 'Agent run not found');
    if (run.role === 'master') return c.json({ error: 'Cannot delete the master agent' }, 400);

    const orchestrator = getCompanyOrchestrator(id);
    if (orchestrator) {
      try {
        await orchestrator.abortSubordinate(agentRunId);
      } catch (error) {
        // Before deleting the durable run row, fence the whole worker if the
        // targeted abort was not acknowledged. This prevents an orphan runner
        // from continuing to write against a row we are about to remove.
        await evictCompanyOrchestrator(id);
        if (!isMutationOutcomeUnknownError(error)) {
          console.warn(
            `[company/agents] abort ${agentRunId} failed; worker evicted before deletion:`,
            error,
          );
        }
      }
    }
    await files.moveAgentRunToTrash(agentRunId);
    return c.json({ ok: true });
  });
}
