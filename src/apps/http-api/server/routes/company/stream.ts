import type { Hono } from 'hono';
import type { ServerDeps } from '../../deps.js';
import { CompanyOrchestrator } from '../../../../../core/coder/company/orchestrator.js';
import { orchestratorRegistry } from '../../../sse/OrchestratorRegistry.js';
import { pumpBusToSSE, parseLastEventId } from '../../../sse/pumpBusToSSE.js';
import { parseIdParam, parseJsonBody, notFound } from '../_helpers.js';

/**
 * Backwards-compatible accessor used by sibling routes (kanban.ts).
 * Prefer importing `orchestratorRegistry` directly in new code.
 */
export const activeOrchestrators = {
  get: (id: number) => orchestratorRegistry.get(id),
  has: (id: number) => orchestratorRegistry.has(id),
  delete: (id: number) => orchestratorRegistry.delete(id),
  set: (id: number, o: CompanyOrchestrator) => orchestratorRegistry.set(id, o),
};

interface StartBody {
  user_message: string;
  max_turns?: number;
}

interface PlanResponseBody {
  approved: boolean;
  feedback?: string;
  /** Optional id of the master_prompt being resolved (idempotent across replay). */
  prompt_id?: number;
}

export function mountCompanyStreamRoutes(app: Hono, deps: ServerDeps): void {
  const { companyStore, db } = deps;

  /**
   * Start the company session — spawns the Master agent and returns
   * a multiplexed SSE stream with all agent events enveloped.
   *
   * IMPORTANT: We AWAIT startMaster() before opening SSE. This ensures
   * the runner is wired to the metaBus before any events are emitted.
   * The subscribe with sinceSeq=-1 replays ALL buffered events, so
   * events emitted during startMaster() are never lost.
   */
  app.post('/api/company/sessions/:id/start', async (c) => {
    const id = parseIdParam(c);
    const session = companyStore.getCompanySession(id);
    if (!session) return notFound(c);
    if (session.status === 'running') {
      return c.json({ error: 'Already running' }, 409);
    }

    const body = await parseJsonBody<StartBody>(c);
    if (!body.user_message) {
      return c.json({ error: 'user_message required' }, 400);
    }

    // Parse config from DB — this is the source of truth for roles
    let config: {
      master_provider?: string;
      master_model?: string;
      role_assignments?: Array<{ role: string; provider: string; model: string; tier: string; skills?: string[] }>;
    } = {};
    try { config = JSON.parse(session.config_json); } catch { /* use defaults */ }

    const roleConfigs = (config.role_assignments ?? []) as Array<{
      role: string; provider: string; model: string; tier: string; skills?: string[];
    }>;

    const orchestrator = new CompanyOrchestrator({
      companySessionId: id,
      companyStore,
      db,
    });
    orchestratorRegistry.set(id, orchestrator);

    // Await startMaster — if it fails, return JSON error (not a broken SSE stream)
    try {
      await orchestrator.startMaster({
        userMessage: body.user_message,
        provider: config.master_provider ?? 'anthropic',
        model: config.master_model ?? 'claude-sonnet-4-6',
        maxTurns: body.max_turns ?? 100,
        roleConfigs,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[company] Master start failed:`, msg);
      orchestratorRegistry.delete(id);
      companyStore.updateCompanySessionStatus(id, 'error');
      return c.json({ error: `Master start failed: ${msg}` }, 500);
    }

    // Persist the user message so it survives page reload
    companyStore.setLastUserMessage(id, body.user_message);

    return pumpBusToSSE(c, orchestrator.metaBus, {
      since: -1,
      onDone: () => orchestratorRegistry.scheduleEviction(id),
    });
  });

  /**
   * Reattach to an in-flight company session's SSE stream.
   * Uses Last-Event-ID header for replay from the client's last seen seq.
   */
  app.get('/api/company/sessions/:id/attach', (c) => {
    const id = parseIdParam(c);
    const orchestrator = orchestratorRegistry.get(id);
    if (!orchestrator) return c.json({ error: 'No active orchestrator' }, 404);

    return pumpBusToSSE(c, orchestrator.metaBus, {
      since: parseLastEventId(c),
    });
  });

  /**
   * Resume a company session that has already run (completed/paused/error).
   * Creates a new orchestrator but resumes the master from the EXISTING coder
   * session, preserving full conversation history and board context.
   */
  app.post('/api/company/sessions/:id/resume', async (c) => {
    const id = parseIdParam(c);

    // If there's already an active orchestrator, use sendMessage instead
    const existing = orchestratorRegistry.get(id);
    if (existing) {
      const body = await parseJsonBody<{ message: string }>(c);
      if (body.message) existing.sendMessageToMaster(body.message);

      return pumpBusToSSE(c, existing.metaBus, {
        since: parseLastEventId(c),
      });
    }

    const session = companyStore.getCompanySession(id);
    if (!session) return notFound(c);

    const body = await parseJsonBody<{ message: string }>(c);
    if (!body.message) return c.json({ error: 'message required' }, 400);

    // Check that there's a master run to resume
    const agentRuns = companyStore.listAgentRuns(id);
    const masterRun = agentRuns.filter((r) => r.role === 'master').pop();
    if (!masterRun) return c.json({ error: 'No master run found — use /start instead' }, 400);

    // Parse role configs from session config
    let config: { role_assignments?: Array<{ role: string; provider: string; model: string; tier: string; skills?: string[] }> } = {};
    try { config = JSON.parse(session.config_json); } catch { /* defaults */ }
    const roleConfigs = config.role_assignments ?? [];

    const orchestrator = new CompanyOrchestrator({ companySessionId: id, companyStore, db });
    orchestratorRegistry.set(id, orchestrator);

    try {
      await orchestrator.resumeExistingMaster({
        userMessage: body.message,
        maxTurns: 100,
        roleConfigs,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[company] Resume failed:`, msg);
      orchestratorRegistry.delete(id);
      return c.json({ error: `Resume failed: ${msg}` }, 500);
    }

    return pumpBusToSSE(c, orchestrator.metaBus, {
      since: -1,
      onDone: () => orchestratorRegistry.scheduleEviction(id),
    });
  });

  /**
   * Abort the entire company session — stops all runners.
   */
  app.post('/api/company/sessions/:id/abort', (c) => {
    const id = parseIdParam(c);
    const orchestrator = orchestratorRegistry.get(id);
    if (!orchestrator) return c.json({ error: 'No active orchestrator' }, 404);
    orchestrator.abortAll();
    orchestratorRegistry.delete(id);
    return c.json({ ok: true });
  });

  /**
   * Switch the master agent's provider/model and optionally update
   * subordinate role defaults. Works both while running (live swap)
   * and while idle (changes take effect on next start/resume).
   */
  app.post('/api/company/sessions/:id/switch', async (c) => {
    const id = parseIdParam(c);
    const session = companyStore.getCompanySession(id);
    if (!session) return notFound(c);

    const body = await parseJsonBody<{
      provider: string;
      model?: string;
      role_assignments?: Array<{ role: string; provider: string; model: string; tier: string; skills?: string[] }>;
    }>(c);

    if (!body.provider) return c.json({ error: 'provider required' }, 400);

    // Update config_json in DB
    let config: Record<string, unknown> = {};
    try { config = JSON.parse(session.config_json); } catch { /* defaults */ }
    config.master_provider = body.provider;
    if (body.model) config.master_model = body.model;
    if (body.role_assignments) config.role_assignments = body.role_assignments;
    companyStore.updateCompanySessionConfig(id, JSON.stringify(config));

    let resolvedProvider = body.provider;
    let resolvedModel = body.model ?? '';

    // Live swap if orchestrator is active
    const orchestrator = orchestratorRegistry.get(id);
    if (orchestrator) {
      try {
        const result = await orchestrator.swapMasterProvider(body.provider, body.model);
        resolvedProvider = result.provider;
        resolvedModel = result.model;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return c.json({ error: `Provider swap failed: ${msg}` }, 500);
      }
      if (body.role_assignments) {
        orchestrator.updateRoleConfigs(body.role_assignments);
      }
    }

    // Update the master's agent_run record
    const agentRuns = companyStore.listAgentRuns(id);
    const masterRun = agentRuns.filter((r) => r.role === 'master').pop();
    if (masterRun) {
      companyStore.updateAgentRunProvider(masterRun.id, resolvedProvider, resolvedModel);
    }

    return c.json({ ok: true, provider: resolvedProvider, model: resolvedModel });
  });

  /**
   * Human responds to the Master's submit_plan.
   * This unblocks the Master's waitForUserInput() call.
   */
  app.post('/api/company/sessions/:id/plan-response', async (c) => {
    const id = parseIdParam(c);
    const orchestrator = orchestratorRegistry.get(id);
    if (!orchestrator) return c.json({ error: 'No active orchestrator' }, 404);

    const body = await parseJsonBody<PlanResponseBody>(c);
    if (body.approved === undefined) {
      return c.json({ error: 'approved field required' }, 400);
    }

    const resolved = orchestrator.respondToMasterPlan(body.approved, body.feedback, body.prompt_id);
    if (!resolved) {
      return c.json(
        { error: 'No pending master plan to respond to (already resolved or session ended)' },
        409,
      );
    }

    return c.json({ ok: true, prompt: resolved });
  });

  /**
   * Send a follow-up message to the Master agent.
   * If master is alive → pushUserMessage. If dead → resumeMasterWithMessage.
   * Message is also posted to the board as "human" for visibility.
   */
  app.post('/api/company/sessions/:id/message', async (c) => {
    const id = parseIdParam(c);
    const orchestrator = orchestratorRegistry.get(id);
    if (!orchestrator) return c.json({ error: 'No active orchestrator' }, 404);

    if (orchestrator.metaBus.ended) {
      return c.json({ error: 'Session has ended. Please start a new session.' }, 410);
    }

    const body = await parseJsonBody<{ message: string }>(c);
    if (!body.message) {
      return c.json({ error: 'message required' }, 400);
    }

    orchestrator.sendMessageToMaster(body.message);
    return c.json({ ok: true });
  });

  /**
   * Human answers a Master agent's ask_user question.
   * This unblocks the Master's waitForUserInput() call.
   */
  app.post('/api/company/sessions/:id/answer', async (c) => {
    const id = parseIdParam(c);
    const orchestrator = orchestratorRegistry.get(id);
    if (!orchestrator) return c.json({ error: 'No active orchestrator' }, 404);

    const body = await parseJsonBody<{ answer: string; prompt_id?: number }>(c);
    if (!body.answer) {
      return c.json({ error: 'answer required' }, 400);
    }

    const resolved = orchestrator.respondToMasterQuestion(body.answer, body.prompt_id);
    if (!resolved) {
      return c.json(
        { error: 'No pending question to answer (already resolved or session ended)' },
        409,
      );
    }

    return c.json({ ok: true, prompt: resolved });
  });

  /**
   * Check if there's an active orchestrator for a company session.
   */
  app.get('/api/company/sessions/:id/status', (c) => {
    const id = parseIdParam(c);
    const orchestrator = orchestratorRegistry.get(id);
    return c.json({
      active: !!orchestrator,
      company_session_id: id,
    });
  });
}
