import type { Hono } from 'hono';
import type { ServerDeps } from '../../deps.js';
import { parseIdParam, parseJsonBody } from '../_helpers.js';
import { collectionInProject, resolveScopedEnv } from './_ownership.js';
import { createJar } from '@mcp/shared/utils/http-engine.js';
import { parseEnvVariables } from '@mcp/services/api-client/request-builder.js';
import { runCollection } from '@mcp/services/api-client/regression-runner.js';
import { importOpenApiInto, importOpenApiContent } from '@mcp/services/api-client/import-openapi.js';

export function mountApiRegressionRoutes(app: Hono, deps: ServerDeps): void {
  const store = deps.apiClientStore;
  const base = '/api/projects/:projectId/api-client';

  // Run the whole collection (synchronous; returns the full report + runId).
  app.post(`${base}/collections/:cid/run`, async (c) => {
    const projectId = parseIdParam(c, 'projectId');
    const cid = parseIdParam(c, 'cid');
    // Ownership guard: a stale cid must not run another project's whole battery,
    // and a stale envId must not run it against another project's base_url +
    // secrets (env falls back to this project's default when foreign/absent).
    if (!collectionInProject(store, projectId, cid)) return c.json({ error: `Collection ${cid} not found` }, 404);
    const body = await parseJsonBody<{ envId?: number; includeMutating?: boolean }>(c);
    const env = resolveScopedEnv(store, projectId, body.envId);

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
      // Persist each ran request's status so the sidebar dots update after a run
      // (one transaction for the whole batch).
      const ran = report.results.filter((r) => !r.skipped && r.actual != null);
      if (ran.length) {
        const now = new Date().toISOString();
        store.transaction(() => {
          for (const r of ran) store.updateRequest(r.requestId, { last_status: r.actual, last_run_at: now });
        });
      }
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
    const projectId = parseIdParam(c, 'projectId');
    const cid = parseIdParam(c, 'cid');
    // A stale cid must not leak another project's run history.
    if (!collectionInProject(store, projectId, cid)) return c.json({ runs: [] });
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

  // Import from uploaded spec content (a file picked in the UI — works anywhere,
  // no project root needed).
  app.post(`${base}/collections/import-openapi-content`, async (c) => {
    const projectId = parseIdParam(c, 'projectId');
    const body = await parseJsonBody<{ content?: string; filename?: string }>(c);
    if (!body.content?.trim()) return c.json({ error: 'no file content provided' }, 400);
    const outcome = await importOpenApiContent(store, { projectId, content: body.content, filename: body.filename });
    if ('error' in outcome) return c.json(outcome, 400);
    return c.json(outcome);
  });
}
