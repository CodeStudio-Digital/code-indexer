import type { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { subscribe, waitEnded, publish, markEnded } from '../../../coder-bus.js';
import type { ServerDeps } from '../../deps.js';
import { CompanyOrchestrator } from '../../../../../core/coder/company/orchestrator.js';

/** Runtime map of active company orchestrators. */
const activeOrchestrators = new Map<number, CompanyOrchestrator>();

interface StartBody {
  user_message: string;
  max_turns?: number;
  role_configs?: Array<{
    role: string;
    provider: string;
    model: string;
    tier: string;
    projectHints?: string[];
  }>;
}

interface MessageBody {
  content: string;
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

    // Parse config
    let config: { master_provider?: string; master_model?: string; role_assignments?: unknown[] } = {};
    try { config = JSON.parse(session.config_json); } catch { /* use defaults */ }

    const orchestrator = new CompanyOrchestrator({
      companySessionId: id,
      companyStore,
      db,
    });
    activeOrchestrators.set(id, orchestrator);

    // Start the master — fire and forget, SSE stream follows.
    // Errors are published to the meta-bus so the SSE client sees them.
    orchestrator.startMaster({
      userMessage: body.user_message,
      provider: config.master_provider ?? 'anthropic',
      model: config.master_model ?? 'claude-sonnet-4-6',
      maxTurns: body.max_turns ?? 100,
      roleConfigs: body.role_configs,
    }).catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[company] Master start failed:`, msg);
      publish(orchestrator.metaBus, 'error', { error: msg });
      markEnded(orchestrator.metaBus, 'error', { error: msg });
    });

    // Return SSE from the meta-bus
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
        // Clean up after linger
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
   */
  app.post('/api/company/sessions/:id/plan-response', async (c) => {
    const id = parseInt(c.req.param('id'), 10);
    const orchestrator = activeOrchestrators.get(id);
    if (!orchestrator) return c.json({ error: 'No active orchestrator' }, 404);

    const body = await c.req.json<PlanResponseBody>().catch(() => ({}) as PlanResponseBody);
    // The master's plan is handled by the regular plan mechanism via provideUserInput
    // This is a placeholder — the actual mechanism uses the same path as regular coder sessions
    return c.json({ ok: true, note: 'Plan response received. Use the coder session plan-response endpoint for the master session.' });
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
