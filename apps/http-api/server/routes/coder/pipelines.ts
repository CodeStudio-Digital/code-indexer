import type { Hono } from 'hono';
import type { ServerDeps } from '../../deps.js';
import type { CoderRuntime } from './state.js';
import { parseIdParam, parseJsonBody, notFound } from '../_helpers.js';
import { validatePipelineGraph } from '@mcp/company/services/PipelineService.js';
import { generateAiPipeline } from '@mcp/api-handlers';
import { ChatPipelineExecutor } from '@mcp/code-agent/pipelines/ChatPipelineExecutor.js';
import { createChatPipelineBus } from '@mcp/code-agent/pipelines/lib/eventBus.js';
import { buildPipelineTools } from '@mcp/code-agent/pipelines/lib/buildPipelineTools.js';
import { createCoderProvider } from '@mcp/services/providers/factory.js';
import { subscribe } from '../../../coder-bus.js';
import type {
  PipelineExecutionStatus,
  PipelineGraph,
} from '@mcp/company/types.js';

/**
 * HTTP routes for the chat pipeline mode (PR-3).
 *
 * Mirrors the company-pipelines surface but binds executions to a
 * `coder_sessions` row instead of a `company_sessions` row. Pipeline
 * executors are lazily instantiated per chat session and live in
 * `runtime.coderPipelineRegistry` until the server restarts.
 *
 * Read paths fall through to `companyStore` so the dashboard can display
 * past executions even when no executor is loaded for the session yet.
 */
export function mountCoderPipelineRoutes(
  app: Hono,
  deps: ServerDeps,
  runtime: CoderRuntime,
): void {
  const { sessionStore, companyStore, db } = deps;

  // ─── List pipelines available to a chat session ──────────────

  app.get('/api/coder/sessions/:id/pipelines', (c) => {
    const sessionId = parseIdParam(c);
    const session = sessionStore.getSession(sessionId);
    if (!session) return notFound(c, 'Session not found');
    // Project scope: pipelines owned by this chat's project + global ones.
    // Company-owned pipelines are intentionally NOT surfaced here — they
    // run via the orchestrator, keeping the two worlds separate.
    return c.json(
      companyStore.listPipelines({ projectId: session.project_id }),
    );
  });

  // ─── Pipeline CRUD (project-scoped, chat builder) ────────────

  app.post('/api/coder/sessions/:id/pipelines', async (c) => {
    const sessionId = parseIdParam(c);
    const session = sessionStore.getSession(sessionId);
    if (!session) return notFound(c, 'Session not found');
    const body = await parseJsonBody<{
      name: string;
      description?: string;
      graph: PipelineGraph;
    }>(c);
    if (!body.name) return c.json({ error: 'name is required' }, 400);
    if (!body.graph) return c.json({ error: 'graph is required' }, 400);
    const validation = validatePipelineGraph(body.graph, null);
    if (!validation.ok) return c.json({ error: 'invalid graph', issues: validation.errors }, 400);
    const created = companyStore.createPipeline({
      name: body.name,
      description: body.description,
      graph: body.graph,
      projectId: session.project_id,
    });
    return c.json(created, 201);
  });

  app.post('/api/coder/sessions/:id/pipelines/validate', async (c) => {
    const body = await parseJsonBody<{ graph?: PipelineGraph }>(c);
    if (!body.graph) return c.json({ error: 'graph is required' }, 400);
    return c.json(validatePipelineGraph(body.graph, null));
  });

  app.post('/api/coder/sessions/:id/pipelines/generate', async (c) => {
    const sessionId = parseIdParam(c);
    const session = sessionStore.getSession(sessionId);
    if (!session) return notFound(c, 'Session not found');
    const body = await parseJsonBody<{ intent?: string }>(c);
    const intent = String(body.intent ?? '').trim();
    if (!intent) return c.json({ error: 'intent is required' }, 400);
    const result = await generateAiPipeline(deps, intent, {
      scope: 'project',
      availableRoles: [],
    });
    if (result.graph) {
      const validation = validatePipelineGraph(result.graph, null);
      if (!validation.ok) {
        return c.json({ summary: result.summary, refusal: 'AI produced an invalid graph.', issues: validation.errors });
      }
    }
    return c.json(result);
  });

  app.patch('/api/coder/sessions/:id/pipelines/:pid', async (c) => {
    const sessionId = parseIdParam(c);
    const pipelineId = parseIdParam(c, 'pid');
    const session = sessionStore.getSession(sessionId);
    if (!session) return notFound(c, 'Session not found');
    const existing = companyStore.getPipeline(pipelineId);
    if (!existing) return notFound(c, 'Pipeline not found');
    if (existing.project_id !== session.project_id) {
      return c.json({ error: 'Pipeline does not belong to this project.' }, 403);
    }
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
      const updated = companyStore.updatePipeline(
        pipelineId,
        { name: body.name, description: body.description, graph: body.graph },
        { expectedVersion: body.expected_version },
      );
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

  app.delete('/api/coder/sessions/:id/pipelines/:pid', (c) => {
    const sessionId = parseIdParam(c);
    const pipelineId = parseIdParam(c, 'pid');
    const session = sessionStore.getSession(sessionId);
    if (!session) return notFound(c, 'Session not found');
    const existing = companyStore.getPipeline(pipelineId);
    if (!existing) return notFound(c, 'Pipeline not found');
    if (existing.project_id !== session.project_id) {
      return c.json({ error: 'Pipeline does not belong to this project.' }, 403);
    }
    const ok = companyStore.deletePipeline(pipelineId);
    if (!ok) return notFound(c, 'Pipeline not found');
    return c.json({ ok: true });
  });

  // ─── Pipeline executions ─────────────────────────────────────

  app.post('/api/coder/sessions/:id/pipelines/:pid/start', async (c) => {
    const sessionId = parseIdParam(c);
    const pipelineId = parseIdParam(c, 'pid');
    const body = await parseJsonBody<{ initial_input?: string }>(c);
    const initialInput = String(body.initial_input ?? '').trim();
    if (!initialInput) return c.json({ error: 'initial_input is required' }, 400);

    const session = sessionStore.getSession(sessionId);
    if (!session) return notFound(c, 'Session not found');

    const pipeline = companyStore.getPipeline(pipelineId);
    if (!pipeline) return notFound(c, 'Pipeline not found');
    // Project gating: a chat session may run a pipeline only when it is
    // global (no owner) or owned by this chat's project. Company-owned
    // pipelines run via the orchestrator, not chat — keeps scopes clean.
    const ownedByProject =
      pipeline.project_id != null && pipeline.project_id === session.project_id;
    const isGlobal =
      pipeline.project_id == null && pipeline.company_session_id == null;
    if (!ownedByProject && !isGlobal) {
      return c.json({ error: 'Pipeline is not available to this project.' }, 403);
    }

    // Re-validate the graph at start time (the graph could have been
    // edited since the dashboard last validated it).
    const validation = validatePipelineGraph(pipeline.graph, null);
    if (!validation.ok) {
      return c.json({ error: 'invalid graph', issues: validation.errors }, 400);
    }

    const project = db.getProject(session.project_id);

    // Lazily instantiate the executor for this session.
    let entry = runtime.coderPipelineRegistry.get(sessionId);
    if (!entry) {
      // Resolve the chat session's default provider so stages without
      // `model_override` inherit it.
      let defaultProvider;
      try {
        defaultProvider = await createCoderProvider(session.provider, session.model);
      } catch (e) {
        return c.json(
          { error: `Could not resolve provider '${session.provider}/${session.model}': ${(e as Error).message}` },
          400,
        );
      }

      const pipelineBus = createChatPipelineBus();
      const executor = new ChatPipelineExecutor({
        coderSessionId: sessionId,
        defaultProvider,
        // Standard read/write toolset — fs, shell, git, web, glob, lsp,
        // diagnostics. MCP-bridged tools and sandbox/DB tools are
        // reserved for a future enhancement (would need MCP bridge
        // booted per run).
        parentTools: buildPipelineTools(),
        baseContext: {
          cwd: project?.root_path ?? process.cwd(),
          projectName: project?.name ?? 'unknown',
        },
        sessionStore,
        companyStore,
        bus: pipelineBus,
      });
      entry = runtime.coderPipelineRegistry.register(sessionId, executor, pipelineBus);
    }

    try {
      const exec = await entry.executor.start(pipelineId, initialInput, 'user');
      return c.json(exec, 201);
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
  });

  app.get('/api/coder/sessions/:id/pipelines/executions', (c) => {
    const sessionId = parseIdParam(c);
    const status = c.req.query('status') as PipelineExecutionStatus | undefined;
    const pipelineRaw = c.req.query('pipeline_id');
    const pipelineId = pipelineRaw ? parseInt(pipelineRaw, 10) : undefined;

    const entry = runtime.coderPipelineRegistry.get(sessionId);
    if (entry) {
      return c.json(
        entry.executor.listExecutions({
          pipelineId: Number.isFinite(pipelineId ?? NaN) ? pipelineId : undefined,
          status,
        }),
      );
    }
    return c.json(
      companyStore.listPipelineExecutions({
        coderSessionId: sessionId,
        pipelineId: Number.isFinite(pipelineId ?? NaN) ? pipelineId : undefined,
        status,
      }),
    );
  });

  app.get('/api/coder/sessions/:id/pipelines/executions/:execId', (c) => {
    const sessionId = parseIdParam(c);
    const execId = parseIdParam(c, 'execId');

    const entry = runtime.coderPipelineRegistry.get(sessionId);
    if (entry) {
      const result = entry.executor.status(execId);
      if (!result) return notFound(c, 'Execution not found');
      return c.json(result);
    }
    const execution = companyStore.getPipelineExecution(execId);
    if (!execution) return notFound(c, 'Execution not found');
    if (execution.coder_session_id !== sessionId) {
      return c.json({ error: 'Execution belongs to a different session.' }, 403);
    }
    const nodes = companyStore.listPipelineNodeExecutions(execId);
    return c.json({ execution, nodes });
  });

  app.post('/api/coder/sessions/:id/pipelines/executions/:execId/abort', async (c) => {
    const sessionId = parseIdParam(c);
    const execId = parseIdParam(c, 'execId');
    const body = await parseJsonBody<{ reason?: string }>(c);

    const entry = runtime.coderPipelineRegistry.get(sessionId);
    if (!entry) {
      return c.json(
        { error: 'No active pipeline executor for this session.' },
        409,
      );
    }
    const ok = entry.executor.abort(execId, body.reason);
    if (!ok) {
      return c.json(
        { error: 'Execution is not abortable (not found or already terminal).' },
        409,
      );
    }
    return c.json({ ok: true });
  });

  app.post('/api/coder/sessions/:id/pipelines/executions/:execId/pause', (c) => {
    const sessionId = parseIdParam(c);
    const execId = parseIdParam(c, 'execId');
    const entry = runtime.coderPipelineRegistry.get(sessionId);
    if (!entry) return c.json({ error: 'No active pipeline executor for this session.' }, 409);
    const ok = entry.executor.pause(execId);
    if (!ok) return c.json({ error: 'Only running executions can be paused.' }, 409);
    return c.json({ ok: true });
  });

  app.post('/api/coder/sessions/:id/pipelines/executions/:execId/resume', async (c) => {
    const sessionId = parseIdParam(c);
    const execId = parseIdParam(c, 'execId');
    const entry = runtime.coderPipelineRegistry.get(sessionId);
    if (!entry) return c.json({ error: 'No active pipeline executor for this session.' }, 409);
    try {
      const ok = await entry.executor.resume(execId);
      if (!ok) return c.json({ error: 'Only paused executions can be resumed.' }, 409);
      return c.json({ ok: true });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
  });

  /**
   * Approve a pause caused by `requires_confirmation`. Distinct verb
   * from `/resume` so the audit log reads clearly; runtime semantics
   * are identical (the executor's `confirm()` strips the marker and
   * delegates to `resume()`).
   */
  app.post('/api/coder/sessions/:id/pipelines/executions/:execId/confirm', async (c) => {
    const sessionId = parseIdParam(c);
    const execId = parseIdParam(c, 'execId');
    const entry = runtime.coderPipelineRegistry.get(sessionId);
    if (!entry) return c.json({ error: 'No active pipeline executor for this session.' }, 409);
    try {
      const ok = await entry.executor.confirm(execId);
      if (!ok) {
        return c.json(
          { error: 'Execution is not paused awaiting confirmation.' },
          409,
        );
      }
      return c.json({ ok: true });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
  });

  // ─── SSE attach for pipeline events ───────────────────────────

  /**
   * Subscribe to pipeline events for this session. Pipeline events flow
   * on a separate long-lived bus (distinct from the per-turn chat bus)
   * so the dashboard can keep watching even when no chat run is active.
   */
  app.get('/api/coder/sessions/:id/pipelines/stream', (c) => {
    const sessionId = parseIdParam(c);
    const entry = runtime.coderPipelineRegistry.get(sessionId);
    if (!entry) {
      return c.json({ error: 'No active pipeline executor for this session.' }, 404);
    }

    const sinceHeader = c.req.header('Last-Event-ID');
    const sinceSeq = sinceHeader ? Number(sinceHeader) : -1;

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const enc = new TextEncoder();
        const send = (event: string, data: unknown, seq: number) => {
          const lines =
            `id: ${seq}\n` +
            `event: ${event}\n` +
            `data: ${JSON.stringify(data)}\n\n`;
          controller.enqueue(enc.encode(lines));
        };

        const unsubscribe = subscribe(
          entry!.bus,
          (ev) => send(ev.event, ev.data, ev.seq),
          Number.isFinite(sinceSeq) ? sinceSeq : -1,
        );

        const onClose = () => {
          try {
            unsubscribe();
          } catch {
            // best-effort
          }
          try {
            controller.close();
          } catch {
            // best-effort
          }
        };
        c.req.raw.signal.addEventListener('abort', onClose, { once: true });
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      },
    });
  });
}
