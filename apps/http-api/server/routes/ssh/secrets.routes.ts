import type { Hono } from 'hono';
import type { ServerDeps } from '../../deps.js';
import { parseIdParam, parseJsonBody, notFound } from '../_helpers.js';
import { secretInProject } from './_ownership.js';
import type { SshSecretPatch } from '@mcp/store/ssh-store-types.js';

/**
 * CRUD for named SSH secrets (migration 197) — values referenced from snippets
 * as `${secret:name}`. `enc_value` arrives already keychain-encrypted by the
 * renderer; the route never sees plaintext. UNIQUE(project_id, name) → a dup
 * name is reported as 409 so the UI can nudge instead of 500-ing.
 */
export function mountSshSecretRoutes(app: Hono, deps: ServerDeps): void {
  const base = '/api/projects/:projectId/ssh';

  app.get(`${base}/secrets`, (c) => {
    const projectId = parseIdParam(c, 'projectId');
    return c.json({ secrets: deps.sshStoreFor(projectId).listSecrets(projectId) });
  });

  app.post(`${base}/secrets`, async (c) => {
    const projectId = parseIdParam(c, 'projectId');
    const store = deps.sshStoreFor(projectId);
    const body = await parseJsonBody<{ name: string; enc_value: string; description?: string }>(c);
    if (!body.name?.trim() || !body.enc_value) {
      return c.json({ error: 'name and enc_value are required' }, 400);
    }
    try {
      return c.json(
        store.createSecret({
          project_id: projectId,
          name: body.name.trim(),
          enc_value: body.enc_value,
          description: body.description?.trim() || null,
        }),
      );
    } catch (e) {
      if (e instanceof Error && /UNIQUE/i.test(e.message)) {
        return c.json({ error: `A secret named "${body.name.trim()}" already exists` }, 409);
      }
      throw e;
    }
  });

  app.patch(`${base}/secrets/:secId`, async (c) => {
    const projectId = parseIdParam(c, 'projectId');
    const store = deps.sshStoreFor(projectId);
    const secId = parseIdParam(c, 'secId');
    if (!secretInProject(store, projectId, secId)) return notFound(c, `Secret ${secId} not found`);
    try {
      store.updateSecret(secId, await parseJsonBody<SshSecretPatch>(c));
    } catch (e) {
      if (e instanceof Error && /UNIQUE/i.test(e.message)) {
        return c.json({ error: 'A secret with that name already exists' }, 409);
      }
      throw e;
    }
    return c.json(store.getSecret(secId));
  });

  app.delete(`${base}/secrets/:secId`, (c) => {
    const projectId = parseIdParam(c, 'projectId');
    const store = deps.sshStoreFor(projectId);
    const secId = parseIdParam(c, 'secId');
    if (!secretInProject(store, projectId, secId)) return notFound(c, `Secret ${secId} not found`);
    store.deleteSecret(secId);
    return c.json({ ok: true });
  });
}
