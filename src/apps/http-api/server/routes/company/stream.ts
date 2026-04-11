import type { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { subscribe, waitEnded } from '../../../coder-bus.js';
import type { ServerDeps } from '../../deps.js';
import { CompanyOrchestrator } from '../../../../../core/coder/company/orchestrator.js';

/** Runtime map of active company orchestrators. */
const activeOrchestrators = new Map<number, CompanyOrchestrator>();

interface StartBody {
  user_message: string;
  max_turns?: number;
}

interface PlanResponseBody {
  approved: boolean;
  feedback?: string;
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
    const id = parseInt(c.req.param('id'), 10);
    const session = companyStore.getCompanySession(id);
    if (!session) return c.json({ error: 'Not found' }, 404);
    if (session.status === 'running') {
      return c.json({ error: 'Already running' }, 409);
    }

    const body = await c.req.json<StartBody>().catch(() => ({}) as StartBody);
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
    activeOrchestrators.set(id, orchestrator);

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
      activeOrchestrators.delete(id);
      companyStore.updateCompanySessionStatus(id, 'error');
      return c.json({ error: `Master start failed: ${msg}` }, 500);
    }

    // Persist the user message so it survives page reload
    companyStore.setLastUserMessage(id, body.user_message);

    // Now open SSE — subscribe with -1 replays all events from buffer
    return streamSSE(c, async (stream) => {
      const unsubscribe = subscribe(
        orchestrator.metaBus,
        (ev) => {
          void stream.writeSSE({
            id: String(ev.seq),
            event: ev.event,
            data: JSON.stringify(ev.data),
          });
        },
        -1,
      );
      try {
        await waitEnded(orchestrator.metaBus);
      } finally {
        unsubscribe();
        await stream.close();
        setTimeout(() => activeOrchestrators.delete(id), 30_000);
      }
    });
  });

  /**
   * Reattach to an in-flight company session's SSE stream.
   */
  app.get('/api/company/sessions/:id/attach', (c) => {
    const id = parseInt(c.req.param('id'), 10);
    const orchestrator = activeOrchestrators.get(id);
    if (!orchestrator) return c.json({ error: 'No active orchestrator' }, 404);

    const sinceHeader = c.req.header('Last-Event-ID');
    const since = sinceHeader ? parseInt(sinceHeader, 10) : -1;

    return streamSSE(c, async (stream) => {
      const unsubscribe = subscribe(
        orchestrator.metaBus,
        (ev) => {
          void stream.writeSSE({
            id: String(ev.seq),
            event: ev.event,
            data: JSON.stringify(ev.data),
          });
        },
        Number.isFinite(since) ? since : -1,
      );
      try {
        await waitEnded(orchestrator.metaBus);
      } finally {
        unsubscribe();
        await stream.close();
      }
    });
  });

  /**
   * Resume a company session that has already run (completed/paused/error).
   * Creates a new orchestrator but resumes the master from the EXISTING coder
   * session, preserving full conversation history and board context.
   */
  app.post('/api/company/sessions/:id/resume', async (c) => {
    const id = parseInt(c.req.param('id'), 10);

    // If there's already an active orchestrator, use sendMessage instead
    if (activeOrchestrators.has(id)) {
      const orchestrator = activeOrchestrators.get(id)!;
      const body = await c.req.json<{ message: string }>().catch(() => ({}) as { message: string });
      if (body.message) orchestrator.sendMessageToMaster(body.message);

      // Reattach to the existing stream
      const sinceHeader = c.req.header('Last-Event-ID');
      const since = sinceHeader ? parseInt(sinceHeader, 10) : -1;
      return streamSSE(c, async (stream) => {
        const unsubscribe = subscribe(orchestrator.metaBus, (ev) => {
          void stream.writeSSE({ id: String(ev.seq), event: ev.event, data: JSON.stringify(ev.data) });
        }, Number.isFinite(since) ? since : -1);
        try { await waitEnded(orchestrator.metaBus); } finally { unsubscribe(); await stream.close(); }
      });
    }

    const session = companyStore.getCompanySession(id);
    if (!session) return c.json({ error: 'Not found' }, 404);

    const body = await c.req.json<{ message: string }>().catch(() => ({}) as { message: string });
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
    activeOrchestrators.set(id, orchestrator);

    try {
      await orchestrator.resumeExistingMaster({
        userMessage: body.message,
        maxTurns: 100,
        roleConfigs,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[company] Resume failed:`, msg);
      activeOrchestrators.delete(id);
      return c.json({ error: `Resume failed: ${msg}` }, 500);
    }

    return streamSSE(c, async (stream) => {
      const unsubscribe = subscribe(orchestrator.metaBus, (ev) => {
        void stream.writeSSE({ id: String(ev.seq), event: ev.event, data: JSON.stringify(ev.data) });
      }, -1);
      try { await waitEnded(orchestrator.metaBus); } finally {
        unsubscribe();
        await stream.close();
        setTimeout(() => activeOrchestrators.delete(id), 30_000);
      }
    });
  });

  /**
   * Abort the entire company session — stops all runners.
   */
  app.post('/api/company/sessions/:id/abort', (c) => {
    const id = parseInt(c.req.param('id'), 10);
    const orchestrator = activeOrchestrators.get(id);
    if (!orchestrator) return c.json({ error: 'No active orchestrator' }, 404);
    orchestrator.abortAll();
    activeOrchestrators.delete(id);
    return c.json({ ok: true });
  });

  /**
   * Human responds to the Master's submit_plan.
   * This unblocks the Master's waitForUserInput() call.
   */
  app.post('/api/company/sessions/:id/plan-response', async (c) => {
    const id = parseInt(c.req.param('id'), 10);
    const orchestrator = activeOrchestrators.get(id);
    if (!orchestrator) return c.json({ error: 'No active orchestrator' }, 404);

    const body = await c.req.json<PlanResponseBody>().catch(() => ({}) as PlanResponseBody);
    if (body.approved === undefined) {
      return c.json({ error: 'approved field required' }, 400);
    }

    const resolved = orchestrator.respondToMasterPlan(body.approved, body.feedback);
    if (!resolved) {
      return c.json({ error: 'No pending master plan to respond to' }, 409);
    }

    return c.json({ ok: true });
  });

  /**
   * Send a follow-up message to the Master agent.
   * If master is alive → pushUserMessage. If dead → resumeMasterWithMessage.
   * Message is also posted to the board as "human" for visibility.
   */
  app.post('/api/company/sessions/:id/message', async (c) => {
    const id = parseInt(c.req.param('id'), 10);
    const orchestrator = activeOrchestrators.get(id);
    if (!orchestrator) return c.json({ error: 'No active orchestrator' }, 404);

    if (orchestrator.metaBus.ended) {
      return c.json({ error: 'Session has ended. Please start a new session.' }, 410);
    }

    const body = await c.req.json<{ message: string }>().catch(() => ({}) as { message: string });
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
    const id = parseInt(c.req.param('id'), 10);
    const orchestrator = activeOrchestrators.get(id);
    if (!orchestrator) return c.json({ error: 'No active orchestrator' }, 404);

    const body = await c.req.json<{ answer: string }>().catch(() => ({}) as { answer: string });
    if (!body.answer) {
      return c.json({ error: 'answer required' }, 400);
    }

    const resolved = orchestrator.respondToMasterQuestion(body.answer);
    if (!resolved) {
      return c.json({ error: 'No pending question to answer' }, 409);
    }

    return c.json({ ok: true });
  });

  /**
   * Check if there's an active orchestrator for a company session.
   */
  app.get('/api/company/sessions/:id/status', (c) => {
    const id = parseInt(c.req.param('id'), 10);
    const orchestrator = activeOrchestrators.get(id);
    return c.json({
      active: !!orchestrator,
      company_session_id: id,
    });
  });
}
