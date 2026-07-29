import type { Hono } from 'hono';
import type { ServerDeps } from '../../deps.js';
import { isMutationOutcomeUnknownError } from '@mcp/orchestrator-host';
import { activeOrchestrators } from './stream.js';
import { evictCompanyOrchestrator } from '../../../sse/companyOrchestrator.js';
import {
  parseIdParam,
  parseJsonBody,
  parseSessionIdParam,
  parseSessionRecordIdParam,
  notFound,
} from '../_helpers.js';
import {
  asCompanySessionId,
  isUuid,
  type CompanySessionId,
} from '@mcp/session-storage';
import { validatePipelineGraph } from '@mcp/company/services/PipelineService.js';
import { generateAiPipeline } from '@mcp/api-handlers';
import type {
  PipelineGraph,
  PipelineExecutionStatus,
} from '@mcp/company/types.js';
import { companySurfaceConflict } from './runtime-capabilities.js';

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
  const { companyStore, operationalSessionFiles } = deps;
  const pipelineIdParam = (
    c: Parameters<typeof parseIdParam>[0],
    name = 'id',
  ): number | string => {
    const raw = c.req.param(name);
    return isUuid(raw) ? raw.toLowerCase() : parseIdParam(c, name);
  };

  const resolveRoot = async (
    sessionId: string,
  ): Promise<CompanySessionId> => {
    let current = asCompanySessionId(sessionId);
    const seen = new Set<string>();
    while (!seen.has(current)) {
      seen.add(current);
      const session =
        await operationalSessionFiles.getCompanySession(current);
      if (!session?.parent_session_id) return current;
      current = asCompanySessionId(session.parent_session_id);
    }
    throw new Error(`Company parent cycle detected for ${sessionId}`);
  };

  const pipelinesUnavailable = async (sessionId: string): Promise<boolean> => {
    const session =
      await operationalSessionFiles.getCompanySession(sessionId);
    return session?.runtime_kind === 'app_studio';
  };

  const pipelineOwnerUnavailable = async (
    pipeline: { company_session_id: string | null },
  ): Promise<boolean> =>
    pipeline.company_session_id != null &&
    await pipelinesUnavailable(pipeline.company_session_id);

  const executionOwnerUnavailable = async (
    executionId: string,
  ): Promise<boolean> => {
    const execution = await companyStore.getPipelineExecution(executionId);
    return execution?.company_session_id != null &&
      await pipelinesUnavailable(execution.company_session_id);
  };

  // ─── Pipeline CRUD ───────────────────────────────────────────

  app.get('/api/company/pipelines', async (c) => {
    const sessionRaw = c.req.query('company_session_id');
    const templateRaw = c.req.query('template_id');
    const opts: { companySessionId?: string | null; templateId?: number | null } = {};
    if (sessionRaw === 'null') opts.companySessionId = null;
    else if (sessionRaw != null) {
      if (isUuid(sessionRaw)) {
        if (await pipelinesUnavailable(sessionRaw)) return c.json([]);
        opts.companySessionId = asCompanySessionId(sessionRaw);
      }
    }
    if (templateRaw != null) {
      const n = parseInt(templateRaw, 10);
      if (Number.isFinite(n)) opts.templateId = n;
    }
    return c.json(await companyStore.listPipelines(opts));
  });

  app.get('/api/company/pipelines/:id', async (c) => {
    const id = pipelineIdParam(c);
    const pipeline = await companyStore.getPipeline(id);
    if (!pipeline) return notFound(c, 'Pipeline not found');
    if (await pipelineOwnerUnavailable(pipeline)) return companySurfaceConflict(c, 'pipelines');
    return c.json(pipeline);
  });

  app.post('/api/company/pipelines', async (c) => {
    const body = await parseJsonBody<{
      name: string;
      description?: string;
      graph: PipelineGraph;
      company_session_id?: string | null;
      template_id?: number | null;
    }>(c);

    if (!body.name) return c.json({ error: 'name is required' }, 400);
    if (!body.graph) return c.json({ error: 'graph is required' }, 400);
    if (
      typeof body.company_session_id === 'string' &&
      await pipelinesUnavailable(body.company_session_id)
    ) {
      return companySurfaceConflict(c, 'pipelines');
    }

    // Validate graph shape; without a session we can't verify roles —
    // pass null so the validator only checks structural invariants.
    const validation = validatePipelineGraph(body.graph, null);
    if (!validation.ok) return c.json({ error: 'invalid graph', issues: validation.errors }, 400);

    const created = await companyStore.createPipeline({
      name: body.name,
      description: body.description,
      graph: body.graph,
      companySessionId: body.company_session_id ?? null,
      templateId: body.template_id ?? null,
    });

    // Best-effort live notify — when the pipeline is bound to an active
    // session, the dashboard's pipelines list refresh listens for this.
    if (created.company_session_id != null) {
      const orchestrator = activeOrchestrators.get(
        asCompanySessionId(created.company_session_id),
      );
      if (orchestrator) {
        try { orchestrator.metaBus; } catch { /* no-op */ }
      }
    }
    return c.json(created, 201);
  });

  app.patch('/api/company/pipelines/:id', async (c) => {
    const id = pipelineIdParam(c);
    const current = await companyStore.getPipeline(id);
    if (!current) return notFound(c, 'Pipeline not found');
    if (await pipelineOwnerUnavailable(current)) return companySurfaceConflict(c, 'pipelines');
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
      const updated = await companyStore.updatePipeline(id, {
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

  app.delete('/api/company/pipelines/:id', async (c) => {
    const id = pipelineIdParam(c);
    const pipeline = await companyStore.getPipeline(id);
    if (!pipeline) return notFound(c, 'Pipeline not found');
    if (await pipelineOwnerUnavailable(pipeline)) return companySurfaceConflict(c, 'pipelines');
    const ok = await companyStore.deletePipeline(id);
    if (!ok) return notFound(c, 'Pipeline not found');
    return c.json({ ok: true });
  });

  app.post('/api/company/pipelines/generate', async (c) => {
    const body = await parseJsonBody<{ intent?: string; available_roles?: string[] }>(c);
    const intent = String(body.intent ?? '').trim();
    if (!intent) return c.json({ error: 'intent is required' }, 400);
    const result = await generateAiPipeline(deps, intent, {
      scope: 'company',
      availableRoles: Array.isArray(body.available_roles) ? body.available_roles : [],
    });
    if (result.graph) {
      const validation = validatePipelineGraph(result.graph, null);
      if (!validation.ok) {
        return c.json({ summary: result.summary, refusal: 'AI produced an invalid graph.', issues: validation.errors });
      }
    }
    return c.json(result);
  });

  app.post('/api/company/pipelines/:id/validate', async (c) => {
    const id = pipelineIdParam(c);
    const body = await parseJsonBody<{ graph?: PipelineGraph; session_id?: string }>(c);

    let graph: PipelineGraph | undefined = body.graph;
    if (!graph) {
      const pipeline = await companyStore.getPipeline(id);
      if (!pipeline) return notFound(c, 'Pipeline not found');
      if (await pipelineOwnerUnavailable(pipeline)) return companySurfaceConflict(c, 'pipelines');
      graph = pipeline.graph;
    }

    let validRoles: ReadonlySet<string> | null = null;
    if (typeof body.session_id === 'string') {
      if (await pipelinesUnavailable(body.session_id)) {
        return companySurfaceConflict(c, 'pipelines');
      }
      const orchestrator = activeOrchestrators.get(
        asCompanySessionId(body.session_id),
      );
      if (orchestrator) {
        const roleSummary = await orchestrator.pipelineValidate(graph);
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
    const sessionId = await resolveRoot(parseSessionIdParam(c));
    const pipelineId = pipelineIdParam(c, 'pid');
    if (await pipelinesUnavailable(sessionId)) return companySurfaceConflict(c, 'pipelines');
    const pipeline = await companyStore.getPipeline(pipelineId);
    if (pipeline && await pipelineOwnerUnavailable(pipeline)) {
      return companySurfaceConflict(c, 'pipelines');
    }
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
      if (isMutationOutcomeUnknownError(e)) {
        await evictCompanyOrchestrator(sessionId);
        return c.json({
          error:
            'Pipeline start outcome is unknown because its worker acknowledgement ' +
            'was lost; the execution was not started again.',
          code: 'OUTCOME_UNKNOWN',
          pipeline_id: pipelineId,
        }, 500);
      }
      return c.json({ error: (e as Error).message }, 400);
    }
  });

  app.get('/api/company/sessions/:id/pipelines/executions', async (c) => {
    const sessionId = await resolveRoot(parseSessionIdParam(c));
    if (await pipelinesUnavailable(sessionId)) return c.json([]);
    const orchestrator = activeOrchestrators.get(sessionId);
    const status = c.req.query('status') as PipelineExecutionStatus | undefined;
    const pipelineRaw = c.req.query('pipeline_id');
    const pipelineId = pipelineRaw
      ? isUuid(pipelineRaw)
        ? pipelineRaw.toLowerCase()
        : Number.parseInt(pipelineRaw, 10)
      : undefined;
    const validPipelineId =
      typeof pipelineId === 'string' ||
      (
        typeof pipelineId === 'number' &&
        Number.isSafeInteger(pipelineId) &&
        pipelineId > 0
      )
        ? pipelineId
        : undefined;

    if (orchestrator) {
      return c.json(await orchestrator.pipelineListExecutions({
        pipelineId: validPipelineId,
        status,
      }));
    }
    // Read-only fallback when the session orchestrator isn't loaded.
    return c.json(await companyStore.listPipelineExecutions({
      companySessionId: sessionId,
      pipelineId: validPipelineId,
      status,
    }));
  });

  app.get('/api/company/sessions/:id/pipelines/executions/:execId', async (c) => {
    const sessionId = await resolveRoot(parseSessionIdParam(c));
    const execId = parseSessionRecordIdParam(c, 'execId');
    if (await pipelinesUnavailable(sessionId) || await executionOwnerUnavailable(execId)) {
      return companySurfaceConflict(c, 'pipelines');
    }

    const orchestrator = activeOrchestrators.get(sessionId);
    if (orchestrator) {
      const result = await orchestrator.pipelineStatus(execId);
      if (!result) return notFound(c, 'Execution not found');
      return c.json(result);
    }
    const execution = await companyStore.getPipelineExecution(execId);
    if (!execution) return notFound(c, 'Execution not found');
    const nodes = await companyStore.listPipelineNodeExecutions(execId);
    return c.json({ execution, nodes });
  });

  app.post('/api/company/sessions/:id/pipelines/executions/:execId/abort', async (c) => {
    const sessionId = await resolveRoot(parseSessionIdParam(c));
    const execId = parseSessionRecordIdParam(c, 'execId');
    if (await pipelinesUnavailable(sessionId) || await executionOwnerUnavailable(execId)) {
      return companySurfaceConflict(c, 'pipelines');
    }
    const body = await parseJsonBody<{ reason?: string }>(c);

    const orchestrator = activeOrchestrators.get(sessionId);
    if (!orchestrator) {
      return c.json({
        error: 'Session is not running; cannot abort. Reload the session and try again.',
      }, 409);
    }
    let ok: boolean;
    try {
      ok = await orchestrator.pipelineAbort(execId, body.reason);
    } catch (error) {
      if (isMutationOutcomeUnknownError(error)) {
        await evictCompanyOrchestrator(sessionId);
        return c.json({
          error: 'Pipeline abort outcome is unknown because the worker acknowledgement was lost.',
          code: 'OUTCOME_UNKNOWN',
        }, 500);
      }
      throw error;
    }
    if (!ok) return c.json({ error: 'Execution is not abortable (not found or already terminal).' }, 409);
    return c.json({ ok: true });
  });

  app.post('/api/company/sessions/:id/pipelines/executions/:execId/pause', async (c) => {
    const sessionId = await resolveRoot(parseSessionIdParam(c));
    const execId = parseSessionRecordIdParam(c, 'execId');
    if (await pipelinesUnavailable(sessionId) || await executionOwnerUnavailable(execId)) {
      return companySurfaceConflict(c, 'pipelines');
    }
    const orchestrator = activeOrchestrators.get(sessionId);
    if (!orchestrator) {
      return c.json({ error: 'Session is not running.' }, 409);
    }
    let ok: boolean;
    try {
      ok = await orchestrator.pipelinePause(execId);
    } catch (error) {
      if (isMutationOutcomeUnknownError(error)) {
        await evictCompanyOrchestrator(sessionId);
        return c.json({
          error: 'Pipeline pause outcome is unknown because the worker acknowledgement was lost.',
          code: 'OUTCOME_UNKNOWN',
        }, 500);
      }
      throw error;
    }
    if (!ok) return c.json({ error: 'Only running executions can be paused.' }, 409);
    return c.json({ ok: true });
  });

  app.post('/api/company/sessions/:id/pipelines/executions/:execId/resume', async (c) => {
    const sessionId = await resolveRoot(parseSessionIdParam(c));
    const execId = parseSessionRecordIdParam(c, 'execId');
    if (await pipelinesUnavailable(sessionId) || await executionOwnerUnavailable(execId)) {
      return companySurfaceConflict(c, 'pipelines');
    }
    const orchestrator = activeOrchestrators.get(sessionId);
    if (!orchestrator) {
      return c.json({ error: 'Session is not running.' }, 409);
    }
    try {
      const ok = await orchestrator.pipelineResume(execId);
      if (!ok) return c.json({ error: 'Only paused executions can be resumed.' }, 409);
      return c.json({ ok: true });
    } catch (e) {
      if (isMutationOutcomeUnknownError(e)) {
        await evictCompanyOrchestrator(sessionId);
        return c.json({
          error:
            'Pipeline resume outcome is unknown because its worker acknowledgement ' +
            'was lost; execution was not resumed again.',
          code: 'OUTCOME_UNKNOWN',
        }, 500);
      }
      return c.json({ error: (e as Error).message }, 400);
    }
  });

  app.post('/api/company/sessions/:id/pipelines/executions/:execId/confirm', async (c) => {
    const sessionId = await resolveRoot(parseSessionIdParam(c));
    const execId = parseSessionRecordIdParam(c, 'execId');
    if (await pipelinesUnavailable(sessionId) || await executionOwnerUnavailable(execId)) {
      return companySurfaceConflict(c, 'pipelines');
    }
    const orchestrator = activeOrchestrators.get(sessionId);
    if (!orchestrator) {
      return c.json({ error: 'Session is not running.' }, 409);
    }
    try {
      const ok = await orchestrator.pipelineConfirm(execId);
      if (!ok) return c.json({ error: 'Execution is not paused awaiting confirmation.' }, 409);
      return c.json({ ok: true });
    } catch (e) {
      if (isMutationOutcomeUnknownError(e)) {
        await evictCompanyOrchestrator(sessionId);
        return c.json({
          error:
            'Pipeline confirmation outcome is unknown because its worker ' +
            'acknowledgement was lost; confirmation was not replayed.',
          code: 'OUTCOME_UNKNOWN',
        }, 500);
      }
      return c.json({ error: (e as Error).message }, 400);
    }
  });
}
