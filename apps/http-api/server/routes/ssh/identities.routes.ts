import type { Hono } from 'hono';
import type { ServerDeps } from '../../deps.js';
import { parseIdParam, parseJsonBody, notFound } from '../_helpers.js';
import { identityInProject } from './_ownership.js';
import type { CreateSshIdentityInput, SshIdentityPatch } from '@mcp/store/ssh-store-types.js';

/**
 * CRUD for reusable SSH identities (migration 173) — a credential (key or
 * password) + default username shared across hosts. Project-scoped.
 */
export function mountSshIdentityRoutes(app: Hono, deps: ServerDeps): void {
  const base = '/api/projects/:projectId/ssh';

  app.get(`${base}/identities`, (c) => {
    const projectId = parseIdParam(c, 'projectId');
    return c.json({ identities: deps.sshStoreFor(projectId).listIdentities(projectId) });
  });

  app.post(`${base}/identities`, async (c) => {
    const projectId = parseIdParam(c, 'projectId');
    const store = deps.sshStoreFor(projectId);
    const body = await parseJsonBody<Omit<CreateSshIdentityInput, 'project_id'>>(c);
    if (!body.name?.trim() || !body.auth_kind) {
      return c.json({ error: 'name and auth_kind are required' }, 400);
    }
    return c.json(
      store.createIdentity({
        project_id: projectId,
        name: body.name.trim(),
        username: body.username ?? null,
        auth_kind: body.auth_kind,
        enc_password: body.enc_password ?? null,
        enc_private_key: body.enc_private_key ?? null,
        enc_passphrase: body.enc_passphrase ?? null,
        public_key: body.public_key ?? null,
        key_type: body.key_type ?? null,
      }),
    );
  });

  app.patch(`${base}/identities/:iid`, async (c) => {
    const projectId = parseIdParam(c, 'projectId');
    const store = deps.sshStoreFor(projectId);
    const iid = parseIdParam(c, 'iid');
    if (!identityInProject(store, projectId, iid)) return notFound(c, `Identity ${iid} not found`);
    store.updateIdentity(iid, await parseJsonBody<SshIdentityPatch>(c));
    return c.json(store.getIdentity(iid));
  });

  app.delete(`${base}/identities/:iid`, (c) => {
    const projectId = parseIdParam(c, 'projectId');
    const store = deps.sshStoreFor(projectId);
    const iid = parseIdParam(c, 'iid');
    if (!identityInProject(store, projectId, iid)) return notFound(c, `Identity ${iid} not found`);
    store.deleteIdentity(iid);
    return c.json({ ok: true });
  });
}
