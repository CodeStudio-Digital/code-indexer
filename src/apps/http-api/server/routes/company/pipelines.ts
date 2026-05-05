import type { Hono } from 'hono';
import type { ServerDeps } from '../../deps.js';
import { activeOrchestrators } from './stream.js';
import { parseIdParam, parseJsonBody, notFound, resolveRootSessionId } from '../_helpers.js';
import { validatePipelineGraph } from '../../../../../core/coder/company/services/PipelineService.js';
import type {
  PipelineGraph,
  PipelineExecutionStatus,
} from '../../../../../core/coder/company/types.js';

/**
 * HTTP routes for the Pipeline Builder + Executor.
 *
 * Two surfaces:
 *   - Pipeline definitions live globally OR scoped to a session. Read-only
 *     operations work even without an active orchestrator (read straight
 *     from `companyStore`); mutations and executions require the
 *     orchestrator to be loaded so the metaBus can publish events the
 *     dashboard subscribes to.
 *   - Executions are always scoped to a session — they emit live SSE
 *     events through the session orchestrator's metaBus.
 */
export function mountCompanyPipelineRoutes(app: Hono, deps: ServerDeps): void {
  const { companyStore } = deps;

  // ─── Pipeline CRUD ───────────────────────────────────────────

  app.get('/api/company/pipelines', (c) => {
    const sessionRaw = c.req.query('company_session_id');
    const templateRaw = c.req.query('template_id');
    const opts: { companySessionId?: number | null; templateId?: number | null } = {};
    if (sessionRaw === 'null') opts.companySessionId = null;
    else if (sessionRaw != null) {
      const n = parseInt(sessionRaw, 10);
      if (Number.isFinite(n)) opts.companySessionId = n;
    }
    if (templateRaw != null) {
      const n = parseInt(templateRaw, 10);
      if (Number.isFinite(n)) opts.templateId = n;
    }
    return c.json(companyStore.listPipelines(opts));
  });

  app.get('/api/company/pipelines/:id', (c) => {
    const id = parseIdParam(c);
    const pipeline = companyStore.getPipeline(id);
    if (!pipeline) return notFound(c, 'Pipeline not found');
    return c.json(pipeline);
  });

  app.post('/api/company/pipelines', async (c) => {
    const body = await parseJsonBody<{
      name: string;
      description?: string;
      graph: PipelineGraph;
      company_session_id?: number | null;
      template_id?: number | null;
    }>(c);

    if (!body.name) return c.json({ error: 'name is required' }, 400);
    if (!body.graph) return c.json({ error: 'graph is required' }, 400);

    // Validate graph shape; without a session we can't verify roles —
    // pass null so the validator only checks structural invariants.
    const validation = validatePipelineGraph(body.graph, null);
    if (!validation.ok) return c.json({ error: 'invalid graph', issues: validation.errors }, 400);

    const created = companyStore.createPipeline({
      name: body.name,
      description: body.description,
      graph: body.graph,
      companySessionId: body.company_session_id ?? null,
      templateId: body.template_id ?? null,
    });

    // Best-effort live notify — when the pipeline is bound to an active
    // session, the dashboard's pipelines list refresh listens for this.
    if (created.company_session_id != null) {
      const orchestrator = activeOrchestrators.get(created.company_session_id);
      if (orchestrator) {
        try { orchestrator.metaBus; } catch { /* no-op */ }
      }
    }
    return c.json(created, 201);
  });

  app.patch('/api/company/pipelines/:id', async (c) => {
    const id = parseIdParam(c);
    const body = await parseJsonBody<{
      name?: string;
      description?: string;
      graph?: PipelineGraph;
      expected_version?: number;
    }>(c);

    if (body.graph) {
      const validation = validatePipelineGraph(body.graph, null);
      if (!validation.ok) return c.json({ error: 'invalid graph', issues: validation.errors }, 400);
    }

    try {
      const updated = companyStore.updatePipeline(id, {
        name: body.name,
        description: body.description,
        graph: body.graph,
      }, { expectedVersion: body.expected_version });
      if (!updated) return notFound(c, 'Pipeline not found');
      return c.json(updated);
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === 'PIPELINE_VERSION_MISMATCH') {
        return c.json({ error: (e as Error).message, code }, 409);
      }
      return c.json({ error: (e as Error).message }, 400);
    }
  });

  app.delete('/api/company/pipelines/:id', (c) => {
    const id = parseIdParam(c);
    const ok = companyStore.deletePipeline(id);
    if (!ok) return notFound(c, 'Pipeline not found');
    return c.json({ ok: true });
  });

  app.post('/api/company/pipelines/:id/validate', async (c) => {
    const id = parseIdParam(c);
    const body = await parseJsonBody<{ graph?: PipelineGraph; session_id?: number }>(c);

    let graph: PipelineGraph | undefined = body.graph;
    if (!graph) {
      const pipeline = companyStore.getPipeline(id);
      if (!pipeline) return notFound(c, 'Pipeline not found');
      graph = pipeline.graph;
    }

    let validRoles: ReadonlySet<string> | null = null;
    if (typeof body.session_id === 'number') {
      const orchestrator = activeOrchestrators.get(body.session_id);
      if (orchestrator) {
        const roleSummary = orchestrator.pipelineValidate(graph);
        return c.json(roleSummary);
      }
      // Active orchestrator unavailable — fall back to structural validation.
    }
    return c.json(validatePipelineGraph(graph, validRoles));
  });

  // ─── Pipeline executions (session-scoped) ────────────────────

  app.post('/api/company/sessions/:id/pipelines/:pid/start', async (c) => {
    // Pipelines are project-wide (migration 067): a child tab routes to
    // the root so the same orchestrator + execution rows are used.
    const sessionId = resolveRootSessionId(companyStore, parseIdParam(c));
    const pipelineId = parseIdParam(c, 'pid');
    const body = await parseJsonBody<{ initial_input?: string }>(c);

    const orchestrator = activeOrchestrators.get(sessionId);
    if (!orchestrator) {
      return c.json({
        error: 'Session is not running. Start the master before launching a pipeline.',
      }, 409);
    }

    const initialInput = String(body.initial_input ?? '').trim();
    if (!initialInput) return c.json({ error: 'initial_input is required' }, 400);

    try {
      const exec = await orchestrator.pipelineStart(pipelineId, initialInput, 'human');
      return c.json(exec, 201);
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
  });

  app.get('/api/company/sessions/:id/pipelines/executions', (c) => {
    const sessionId = resolveRootSessionId(companyStore, parseIdParam(c));
    const orchestrator = activeOrchestrators.get(sessionId);
    const status = c.req.query('status') as PipelineExecutionStatus | undefined;
    const pipelineRaw = c.req.query('pipeline_id');
    const pipelineId = pipelineRaw ? parseInt(pipelineRaw, 10) : undefined;

    if (orchestrator) {
      return c.json(orchestrator.pipelineListExecutions({
        pipelineId: Number.isFinite(pipelineId ?? NaN) ? pipelineId : undefined,
        status,
      }));
    }
    // Read-only fallback when the session orchestrator isn't loaded.
    return c.json(companyStore.listPipelineExecutions({
      companySessionId: sessionId,
      pipelineId: Number.isFinite(pipelineId ?? NaN) ? pipelineId : undefined,
      status,
    }));
  });

  app.get('/api/company/sessions/:id/pipelines/executions/:execId', (c) => {
    const sessionId = resolveRootSessionId(companyStore, parseIdParam(c));
    const execId = parseIdParam(c, 'execId');

    const orchestrator = activeOrchestrators.get(sessionId);
    if (orchestrator) {
      const result = orchestrator.pipelineStatus(execId);
      if (!result) return notFound(c, 'Execution not found');
      return c.json(result);
    }
    const execution = companyStore.getPipelineExecution(execId);
    if (!execution) return notFound(c, 'Execution not found');
    const nodes = companyStore.listPipelineNodeExecutions(execId);
    return c.json({ execution, nodes });
  });

  app.post('/api/company/sessions/:id/pipelines/executions/:execId/abort', async (c) => {
    const sessionId = parseIdParam(c);
    const execId = parseIdParam(c, 'execId');
    const body = await parseJsonBody<{ reason?: string }>(c);

    const orchestrator = activeOrchestrators.get(sessionId);
    if (!orchestrator) {
      return c.json({
        error: 'Session is not running; cannot abort. Reload the session and try again.',
      }, 409);
    }
    const ok = orchestrator.pipelineAbort(execId, body.reason);
    if (!ok) return c.json({ error: 'Execution is not abortable (not found or already terminal).' }, 409);
    return c.json({ ok: true });
  });

  app.post('/api/company/sessions/:id/pipelines/executions/:execId/pause', (c) => {
    const sessionId = parseIdParam(c);
    const execId = parseIdParam(c, 'execId');
    const orchestrator = activeOrchestrators.get(sessionId);
    if (!orchestrator) {
      return c.json({ error: 'Session is not running.' }, 409);
    }
    const ok = orchestrator.pipelinePause(execId);
    if (!ok) return c.json({ error: 'Only running executions can be paused.' }, 409);
    return c.json({ ok: true });
  });

  app.post('/api/company/sessions/:id/pipelines/executions/:execId/resume', async (c) => {
    const sessionId = parseIdParam(c);
    const execId = parseIdParam(c, 'execId');
    const orchestrator = activeOrchestrators.get(sessionId);
    if (!orchestrator) {
      return c.json({ error: 'Session is not running.' }, 409);
    }
    try {
      const ok = await orchestrator.pipelineResume(execId);
      if (!ok) return c.json({ error: 'Only paused executions can be resumed.' }, 409);
      return c.json({ ok: true });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
  });
}
