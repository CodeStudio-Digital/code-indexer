import type { Hono } from 'hono';
import type { ServerDeps } from '../../deps.js';
import { parseIdParam, parseJsonBody, notFound } from '../_helpers.js';
import { environmentInProject } from './_ownership.js';
import { maskSecrets, mergeSecrets, type EnvVarMap } from '@mcp/services/api-client/env-secrets.js';

/**
 * CRUD for API-client environments (migration 147). An environment holds a
 * base_url + a `{ key: { value, secret } }` variable map; `{{var}}` templates
 * in requests resolve against the selected env at send time.
 *
 * Secret values never leave the server in cleartext: the GET list masks them
 * with a sentinel, and an upsert that sends the sentinel back keeps the stored
 * value (so editing other fields — or toggling secret off — doesn't wipe it).
 * The send/regression paths read the RAW store value server-side. Masking
 * logic lives in @mcp/services/api-client/env-secrets (pure + tested).
 */
export function mountApiEnvironmentRoutes(app: Hono, deps: ServerDeps): void {
  // R1 — `store` is resolved per-request via deps.apiClientFor(projectId).
  const base = '/api/projects/:projectId/api-client';

  app.get(`${base}/environments`, (c) => {
    const projectId = parseIdParam(c, 'projectId');
    const store = deps.apiClientFor(projectId);
    const environments = store.listEnvironments(projectId)
      .map((e) => ({ ...e, variables_json: maskSecrets(e.variables_json) }));
    return c.json({ environments });
  });

  // Upsert (PUT with optional `id` in the body — create when absent).
  app.put(`${base}/environments`, async (c) => {
    const projectId = parseIdParam(c, 'projectId');
    const store = deps.apiClientFor(projectId);
    const body = await parseJsonBody<{
      id?: number;
      name: string;
      base_url?: string;
      variables?: EnvVarMap;
      variables_json?: string;
      is_default?: boolean;
    }>(c);
    if (!body.name?.trim()) return c.json({ error: 'name is required' }, 400);

    // Update path: the body's env id must belong to THIS project. Without the
    // check a stale id from another project would be rewritten here (name,
    // base_url, secrets) and its is_default flag flipped via the project-scoped
    // UPDATE inside upsertEnvironment — cross-project tampering.
    const existing = body.id != null ? environmentInProject(store, projectId, body.id) : null;
    if (body.id != null && !existing) return notFound(c, `Environment ${body.id} not found`);

    let variables_json = body.variables_json;
    if (body.variables !== undefined) {
      // mergeSecrets reads the existing (project-scoped) row so the secret
      // sentinel preserves THIS project's stored secret, never a foreign one.
      variables_json = JSON.stringify(mergeSecrets(body.variables, existing?.variables_json));
    }
    return c.json(store.upsertEnvironment({
      id: body.id,
      project_id: projectId,
      name: body.name.trim(),
      base_url: body.base_url,
      variables_json,
      is_default: body.is_default,
    }));
  });

  app.delete(`${base}/environments/:eid`, (c) => {
    const projectId = parseIdParam(c, 'projectId');
    const store = deps.apiClientFor(projectId);
    const eid = parseIdParam(c, 'eid');
    // A stale eid must not delete another project's environment.
    if (!environmentInProject(store, projectId, eid)) return notFound(c, `Environment ${eid} not found`);
    store.deleteEnvironment(eid);
    return c.json({ ok: true });
  });
}
