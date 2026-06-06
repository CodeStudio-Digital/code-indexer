import type { Hono } from 'hono';
import type { ServerDeps } from '../../deps.js';
import {
  getCompanyOrchestrator,
  getOrSpawnCompanyOrchestrator,
} from '../../../sse/companyOrchestrator.js';
import { parseIdParam, parseJsonBody, notFound } from '../_helpers.js';

/**
 * Per-agent (subordinate) control: pause, resume, delete. The session-wide
 * abort lives in `stream.ts`; these act on a SINGLE `company_agent_runs`
 * row. The Master is intentionally excluded — it's driven by the session
 * abort / delete flows, not these fine-grained controls.
 *
 * NOTE: orchestrator methods are RPC-forwarded to the worker thread, so
 * every call returns a Promise even though `CompanyOrchestrator`'s
 * signatures look synchronous — hence the `await`s below.
 */
export function mountCompanyAgentControlRoutes(app: Hono, deps: ServerDeps): void {
  const { companyStore } = deps;

  /**
   * Pause a running subordinate. Stops its current turn but keeps the
   * session so it can be resumed; status becomes `paused`.
   */
  app.post('/api/company/sessions/:id/agents/:agentRunId/pause', async (c) => {
    const id = parseIdParam(c);
    const agentRunId = parseIdParam(c, 'agentRunId');
    const run = companyStore.getAgentRun(agentRunId);
    if (!run || run.company_session_id !== id) return notFound(c, 'Agent run not found');
    if (run.role === 'master') return c.json({ error: 'Cannot pause the master agent' }, 400);

    const orchestrator = getCompanyOrchestrator(id);
    if (!orchestrator) return c.json({ error: 'No active orchestrator' }, 404);

    const ok = await orchestrator.pauseSubordinate(agentRunId);
    if (!ok) return c.json({ error: 'Agent is not running' }, 409);
    return c.json({ ok: true });
  });

  /**
   * Resume a paused / stopped subordinate. Revives the worker if it was
   * evicted (idle TTL). Optional `{ message, thinking }` steers the
   * continuation; defaults to a generic "continue" prompt.
   */
  app.post('/api/company/sessions/:id/agents/:agentRunId/resume', async (c) => {
    const id = parseIdParam(c);
    const agentRunId = parseIdParam(c, 'agentRunId');
    const run = companyStore.getAgentRun(agentRunId);
    if (!run || run.company_session_id !== id) return notFound(c, 'Agent run not found');
    if (run.role === 'master') return c.json({ error: 'Cannot resume the master agent' }, 400);

    const body = await parseJsonBody<{ message?: string; thinking?: boolean }>(c);
    const { orchestrator } = await getOrSpawnCompanyOrchestrator(id);
    const ok = await orchestrator.reactivateSubordinate(
      agentRunId,
      body.message?.trim() || 'Continue de onde parou.',
      undefined,
      body.thinking,
    );
    if (!ok) return c.json({ error: 'Agent is not in a resumable state' }, 409);
    return c.json({ ok: true });
  });

  /**
   * Delete a subordinate: abort it if a worker is live (best-effort),
   * then remove the `company_agent_runs` row. FK constraints cascade the
   * dependent rows. Works even when no worker is running.
   */
  app.delete('/api/company/sessions/:id/agents/:agentRunId', async (c) => {
    const id = parseIdParam(c);
    const agentRunId = parseIdParam(c, 'agentRunId');
    const run = companyStore.getAgentRun(agentRunId);
    if (!run || run.company_session_id !== id) return notFound(c, 'Agent run not found');
    if (run.role === 'master') return c.json({ error: 'Cannot delete the master agent' }, 400);

    const orchestrator = getCompanyOrchestrator(id);
    if (orchestrator) {
      try { await orchestrator.abortSubordinate(agentRunId); } catch { /* best-effort */ }
    }
    companyStore.deleteAgentRun(agentRunId);
    return c.json({ ok: true });
  });
}
