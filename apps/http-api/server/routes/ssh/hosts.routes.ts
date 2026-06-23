import type { Hono } from 'hono';
import type { ServerDeps } from '../../deps.js';
import { parseIdParam, parseJsonBody, notFound } from '../_helpers.js';
import { hostInProject } from './_ownership.js';
import type { CreateSshHostInput, SshHostPatch } from '@mcp/store/ssh-store-types.js';

/**
 * CRUD for saved SSH hosts (migration 173), project-scoped under
 * /api/projects/:projectId/ssh. `enc_*` secret fields arrive already encrypted
 * by the renderer's safeStorage shim — this layer never sees plaintext.
 */
export function mountSshHostRoutes(app: Hono, deps: ServerDeps): void {
  const base = '/api/projects/:projectId/ssh';

  app.get(`${base}/hosts`, (c) => {
    const projectId = parseIdParam(c, 'projectId');
    return c.json({ hosts: deps.sshStoreFor(projectId).listHosts(projectId) });
  });

  app.get(`${base}/hosts/:hid`, (c) => {
    const projectId = parseIdParam(c, 'projectId');
    const store = deps.sshStoreFor(projectId);
    const hid = parseIdParam(c, 'hid');
    const host = hostInProject(store, projectId, hid);
    if (!host) return notFound(c, `Host ${hid} not found`);
    return c.json(host);
  });

  app.post(`${base}/hosts`, async (c) => {
    const projectId = parseIdParam(c, 'projectId');
    const store = deps.sshStoreFor(projectId);
    const body = await parseJsonBody<Omit<CreateSshHostInput, 'project_id'>>(c);
    if (!body.label?.trim() || !body.hostname?.trim() || !body.username?.trim() || !body.auth_method) {
      return c.json({ error: 'label, hostname, username and auth_method are required' }, 400);
    }
    // A jump host (if any) must belong to this project — never let a stale/foreign id slip in.
    if (body.jump_host_id != null && !hostInProject(store, projectId, body.jump_host_id)) {
      return c.json({ error: 'jump_host_id is not in this project' }, 400);
    }
    return c.json(
      store.createHost({
        project_id: projectId,
        label: body.label.trim(),
        hostname: body.hostname.trim(),
        port: body.port,
        username: body.username.trim(),
        auth_method: body.auth_method,
        identity_id: body.identity_id ?? null,
        enc_password: body.enc_password ?? null,
        enc_private_key: body.enc_private_key ?? null,
        enc_passphrase: body.enc_passphrase ?? null,
        jump_host_id: body.jump_host_id ?? null,
        group_name: body.group_name ?? null,
        tags: body.tags,
        agent_forwarding: body.agent_forwarding,
        keepalive_secs: body.keepalive_secs,
      }),
    );
  });

  app.patch(`${base}/hosts/:hid`, async (c) => {
    const projectId = parseIdParam(c, 'projectId');
    const store = deps.sshStoreFor(projectId);
    const hid = parseIdParam(c, 'hid');
    if (!hostInProject(store, projectId, hid)) return notFound(c, `Host ${hid} not found`);
    const patch = await parseJsonBody<SshHostPatch>(c);
    if (patch.jump_host_id != null && !hostInProject(store, projectId, patch.jump_host_id)) {
      return c.json({ error: 'jump_host_id is not in this project' }, 400);
    }
    store.updateHost(hid, patch);
    return c.json(store.getHost(hid));
  });

  app.delete(`${base}/hosts/:hid`, (c) => {
    const projectId = parseIdParam(c, 'projectId');
    const store = deps.sshStoreFor(projectId);
    const hid = parseIdParam(c, 'hid');
    if (!hostInProject(store, projectId, hid)) return notFound(c, `Host ${hid} not found`);
    store.deleteHost(hid);
    return c.json({ ok: true });
  });
}
