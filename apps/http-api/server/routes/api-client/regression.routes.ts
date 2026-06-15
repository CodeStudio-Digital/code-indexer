import type { Hono } from 'hono';
import type { ServerDeps } from '../../deps.js';
import { parseIdParam, parseJsonBody } from '../_helpers.js';
import { createJar } from '@mcp/shared/utils/http-engine.js';
import { parseEnvVariables } from '@mcp/services/api-client/request-builder.js';
import { runCollection } from '@mcp/services/api-client/regression-runner.js';
import { importOpenApiInto } from '@mcp/services/api-client/import-openapi.js';

export function mountApiRegressionRoutes(app: Hono, deps: ServerDeps): void {
  const store = deps.apiClientStore;
  const base = '/api/projects/:projectId/api-client';

  // Run the whole collection (synchronous; returns the full report + runId).
  app.post(`${base}/collections/:cid/run`, async (c) => {
    const projectId = parseIdParam(c, 'projectId');
    const cid = parseIdParam(c, 'cid');
    if (!store.getCollection(cid)) return c.json({ error: `Collection ${cid} not found` }, 404);
    const body = await parseJsonBody<{ envId?: number; includeMutating?: boolean }>(c);
    const env = body.envId != null ? store.getEnvironment(body.envId) : store.getDefaultEnvironment(projectId);

    const requests = store.listRequests(cid);
    const runId = store.createRun(cid, env?.id ?? null, 'manual');
    try {
      const report = await runCollection({
        requests,
        baseUrl: env?.base_url ?? '',
        variables: parseEnvVariables(env?.variables_json),
        jar: createJar(),
        includeMutating: !!body.includeMutating,
        signal: c.req.raw.signal,
      });
      store.finishRun(runId, {
        status: report.status, total: report.total, passed: report.passed,
        failed: report.failed, results_json: JSON.stringify(report.results),
      });
      return c.json({ runId, ...report });
    } catch (e) {
      // Catastrophic failure (not a per-request assertion) — record the run as
      // errored so it doesn't linger in 'running', and surface it.
      const message = e instanceof Error ? e.message : String(e);
      store.finishRun(runId, { status: 'error', total: 0, passed: 0, failed: 0, results_json: JSON.stringify([{ reason: message }]) });
      return c.json({ error: message, runId }, 500);
    }
  });

  app.get(`${base}/collections/:cid/runs`, (c) => {
    const cid = parseIdParam(c, 'cid');
    return c.json({ runs: store.listRuns(cid) });
  });

  // Import an OpenAPI/Swagger spec → collection (idempotent by spec path).
  app.post(`${base}/collections/import-openapi`, async (c) => {
    const projectId = parseIdParam(c, 'projectId');
    const body = await parseJsonBody<{ specPath?: string }>(c);
    const project = deps.db.getProject(projectId);
    if (!project?.root_path) return c.json({ error: 'project has no root path on disk' }, 422);

    const outcome = await importOpenApiInto(store, { projectId, rootPath: project.root_path, specPath: body.specPath });
    if ('error' in outcome) return c.json(outcome, 404);
    return c.json(outcome);
  });
}
