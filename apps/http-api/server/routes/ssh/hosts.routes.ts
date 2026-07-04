import type { Hono } from 'hono';
import type { ServerDeps } from '../../deps.js';
import { parseIdParam, parseJsonBody, notFound } from '../_helpers.js';
import { sharedOrOwnedHost } from './_ownership.js';
import type { CreateSshHostInput, SshHostPatch } from '@mcp/store/ssh-store-types.js';

/**
 * CRUD for saved SSH hosts (migration 173), project-scoped under
 * /api/projects/:projectId/ssh. `enc_*` secret fields arrive already encrypted
 * by the renderer's safeStorage shim — this layer never sees plaintext.
 *
 * A host can be SHARED across all projects (`is_shared=1`, migration 198): it
 * lives in the CENTRAL store (`deps.sshStore`) so every project — including a
 * split one with its own DB — sees it. The list unions shared + own; item ops
 * resolve via `sharedOrOwnedHost` and operate on whichever store holds the row.
 */
export function mountSshHostRoutes(app: Hono, deps: ServerDeps): void {
  const base = '/api/projects/:projectId/ssh';

  // Valid jump target for a host of the given shared-ness:
  //  - shared host → jump must ALSO be shared (a project-local jump wouldn't
  //    resolve from other projects);
  //  - local host  → jump may be own-project OR shared (e.g. a shared bastion).
  const jumpOk = (projectId: number, hid: number, shared: boolean): boolean =>
    shared ? !!deps.sshStore.getHost(hid)?.is_shared : sharedOrOwnedHost(deps, projectId, hid) != null;

  app.get(`${base}/hosts`, (c) => {
    const projectId = parseIdParam(c, 'projectId');
    // Shared hosts (central) first, then this project's own hosts.
    const hosts = [...deps.sshStore.listSharedHosts(), ...deps.sshStoreFor(projectId).listHosts(projectId)];
    return c.json({ hosts });
  });

  app.get(`${base}/hosts/:hid`, (c) => {
    const projectId = parseIdParam(c, 'projectId');
    const hid = parseIdParam(c, 'hid');
    const found = sharedOrOwnedHost(deps, projectId, hid);
    if (!found) return notFound(c, `Host ${hid} not found`);
    return c.json(found.host);
  });

  app.post(`${base}/hosts`, async (c) => {
    const projectId = parseIdParam(c, 'projectId');
    const body = await parseJsonBody<Omit<CreateSshHostInput, 'project_id'>>(c);
    if (!body.label?.trim() || !body.hostname?.trim() || !body.username?.trim() || !body.auth_method) {
      return c.json({ error: 'label, hostname, username and auth_method are required' }, 400);
    }
    const shared = !!body.is_shared;
    if (body.jump_host_id != null && !jumpOk(projectId, body.jump_host_id, shared)) {
      return c.json({ error: 'jump_host_id is not reachable from this host' }, 400);
    }
    // Shared hosts go in the CENTRAL DB so every project (even split ones) sees them.
    const store = shared ? deps.sshStore : deps.sshStoreFor(projectId);
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
        is_shared: shared,
        keepalive_secs: body.keepalive_secs,
      }),
    );
  });

  app.patch(`${base}/hosts/:hid`, async (c) => {
    const projectId = parseIdParam(c, 'projectId');
    const hid = parseIdParam(c, 'hid');
    const found = sharedOrOwnedHost(deps, projectId, hid);
    if (!found) return notFound(c, `Host ${hid} not found`);
    const patch = await parseJsonBody<SshHostPatch>(c);
    // shared-ness after this patch (it may be toggling is_shared).
    const willBeShared = patch.is_shared ?? !!found.host.is_shared;
    if (patch.jump_host_id != null && !jumpOk(projectId, patch.jump_host_id, willBeShared)) {
      return c.json({ error: 'jump_host_id is not reachable from this host' }, 400);
    }
    found.store.updateHost(hid, patch);
    return c.json(found.store.getHost(hid));
  });

  app.delete(`${base}/hosts/:hid`, (c) => {
    const projectId = parseIdParam(c, 'projectId');
    const hid = parseIdParam(c, 'hid');
    const found = sharedOrOwnedHost(deps, projectId, hid);
    if (!found) return notFound(c, `Host ${hid} not found`);
    found.store.deleteHost(hid);
    return c.json({ ok: true });
  });
}
