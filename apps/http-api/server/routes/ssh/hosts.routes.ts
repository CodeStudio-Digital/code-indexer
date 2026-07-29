import type { Hono } from 'hono';
import type { ServerDeps } from '../../deps.js';
import { parseIdParam, parseJsonBody, notFound } from '../_helpers.js';
import {
  resolveSharedOrOwnedHost,
  sharedOrOwnedHost,
  withHostStorageScope,
  type ResolvedSshHost,
  type SshHostStorageScope,
} from './_ownership.js';
import type { CreateSshHostInput, SshHostPatch, SshHost } from '@mcp/store/ssh-store-types.js';

type SshHostRoutePatch = SshHostPatch & Partial<Pick<SshHost, 'known_host_sha256' | 'startup_snippet_id' | 'last_used_at' | 'sort_order'>>;

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
    const hosts = [
      ...deps.sshStore.listSharedHosts().map((h) => withHostStorageScope(h, 'shared')),
      ...deps.sshStoreFor(projectId).listHosts(projectId).map((h) => withHostStorageScope(h, 'project')),
    ];
    return c.json({ hosts });
  });

  app.get(`${base}/hosts/:hid`, (c) => {
    const projectId = parseIdParam(c, 'projectId');
    const hid = parseIdParam(c, 'hid');
    const found = resolveHostForRoute(deps, projectId, hid, readScope(c.req.query('scope')));
    if (found === 'invalid-scope') return c.json({ error: 'scope must be shared or project' }, 400);
    if (found === 'ambiguous') return c.json({ error: 'ambiguous SSH host id; pass scope=shared or scope=project' }, 409);
    if (!found) return notFound(c, `Host ${hid} not found`);
    return c.json(withHostStorageScope(found.host, found.storage_scope));
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
    const created = store.createHost({
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
    });
    return c.json(withHostStorageScope(created, shared ? 'shared' : 'project'));
  });

  app.patch(`${base}/hosts/:hid`, async (c) => {
    const projectId = parseIdParam(c, 'projectId');
    const hid = parseIdParam(c, 'hid');
    const found = resolveHostForRoute(deps, projectId, hid, readScope(c.req.query('scope')));
    if (found === 'invalid-scope') return c.json({ error: 'scope must be shared or project' }, 400);
    if (found === 'ambiguous') return c.json({ error: 'ambiguous SSH host id; pass scope=shared or scope=project' }, 409);
    if (!found) return notFound(c, `Host ${hid} not found`);
    const patch = await parseJsonBody<SshHostRoutePatch>(c);
    const wasShared = !!found.host.is_shared;
    // shared-ness after this patch (it may be toggling is_shared).
    const willBeShared = patch.is_shared ?? wasShared;
    if (patch.jump_host_id != null && !jumpOk(projectId, patch.jump_host_id, willBeShared)) {
      return c.json({ error: 'jump_host_id is not reachable from this host' }, 400);
    }

    // If is_shared is TOGGLING, the row must physically MOVE between the project
    // DB and the central DB — otherwise it stays stranded: `listHosts` filters
    // `is_shared = 0` and `listSharedHosts` reads only the central DB, so a row
    // flipped in place would be excluded from BOTH lists and vanish from the UI.
    // The id is preserved so `saved:<id>` terminal refs, jump-host FKs and the
    // edit dialog's `initial.id` keep resolving; all other columns travel with
    // the row. No re-trust prompt fires because the ENDPOINT is unchanged and
    // host-key trust lives in `<dataDir>/ssh/known_hosts.json` keyed by
    // `host:port` — NOT in `known_host_sha256`, which nothing writes at runtime.
    if (willBeShared !== wasShared) {
      // shared → local: the row must return to its ORIGIN project's store, not
      // the caller's — a shared host is visible from every project, and only the
      // origin project's `listHosts(project_id)` would surface it once unshared.
      // Moving it into a different project's store would strand it (deleted from
      // central, invisible in the origin, and not matched by the caller's list).
      if (!willBeShared && projectId !== found.host.project_id) {
        return c.json({ error: 'a shared host can only be unshared from its origin project' }, 403);
      }
      const destStore = willBeShared ? deps.sshStore : deps.sshStoreFor(projectId);
      // Guard against an id collision in the destination DB (the two stores have
      // independent AUTOINCREMENT sequences, so the same numeric id could exist
      // in both). Without this, createHostWithId throws a UNIQUE constraint
      // violation → 500. Surface it as a controlled 409 instead, leaving the
      // source row intact so the user can retry / export-import.
      if (destStore.getHost(hid)) {
        return c.json({ error: 'cannot relocate SSH host: destination store already has this id' }, 409);
      }
      // Merge known PATCH fields INTO the snapshot before the single destination
      // insert. This mirrors updateHost's normalization while preserving the
      // non-writable identity/origin columns from the existing row.
      const relocated = applyHostPatchForRelocation(found.host, patch, willBeShared);
      const inserted = destStore.createHostWithId(relocated);
      // Source delete runs ONLY after the insert succeeded. If it throws, roll
      // back the destination insert so the host isn't duplicated across stores
      // (same id in both → ambiguous lists/updates). The original row stays
      // intact; the client sees a 500 and can retry.
      try {
        found.store.deleteHost(hid);
      } catch (err) {
        try { destStore.deleteHost(hid); } catch { /* preserve original error */ }
        throw err;
      }
      return c.json(withHostStorageScope(destStore.getHost(hid) ?? inserted, willBeShared ? 'shared' : 'project'));
    }

    found.store.updateHost(hid, patch);
    const updated = found.store.getHost(hid);
    return c.json(updated ? withHostStorageScope(updated, found.storage_scope) : updated);
  });

  app.delete(`${base}/hosts/:hid`, (c) => {
    const projectId = parseIdParam(c, 'projectId');
    const hid = parseIdParam(c, 'hid');
    const found = resolveHostForRoute(deps, projectId, hid, readScope(c.req.query('scope')));
    if (found === 'invalid-scope') return c.json({ error: 'scope must be shared or project' }, 400);
    if (found === 'ambiguous') return c.json({ error: 'ambiguous SSH host id; pass scope=shared or scope=project' }, 409);
    if (!found) return notFound(c, `Host ${hid} not found`);
    found.store.deleteHost(hid);
    return c.json({ ok: true });
  });
}

function readScope(raw: string | undefined): SshHostStorageScope | 'invalid-scope' | undefined {
  if (raw == null || raw === '') return undefined;
  return raw === 'shared' || raw === 'project' ? raw : 'invalid-scope';
}

function resolveHostForRoute(
  deps: Pick<ServerDeps, 'sshStore' | 'sshStoreFor'>,
  projectId: number,
  hid: number,
  scope: SshHostStorageScope | 'invalid-scope' | undefined,
): ResolvedSshHost | null | 'ambiguous' | 'invalid-scope' {
  if (scope === 'invalid-scope') return 'invalid-scope';
  const found = resolveSharedOrOwnedHost(deps, projectId, hid, scope);
  if (found && 'ambiguous' in found) return 'ambiguous';
  return found;
}

function applyHostPatchForRelocation(host: SshHost, patch: Partial<SshHostRoutePatch>, willBeShared: boolean): SshHost {
  const next: SshHost = { ...host, is_shared: willBeShared ? 1 : 0 };
  if (patch.label !== undefined) next.label = patch.label;
  if (patch.hostname !== undefined) next.hostname = patch.hostname;
  if (patch.port !== undefined) next.port = patch.port;
  if (patch.username !== undefined) next.username = patch.username;
  if (patch.auth_method !== undefined) next.auth_method = patch.auth_method;
  if (patch.identity_id !== undefined) next.identity_id = patch.identity_id ?? null;
  if (patch.enc_password !== undefined) next.enc_password = patch.enc_password ?? null;
  if (patch.enc_private_key !== undefined) next.enc_private_key = patch.enc_private_key ?? null;
  if (patch.enc_passphrase !== undefined) next.enc_passphrase = patch.enc_passphrase ?? null;
  if (patch.jump_host_id !== undefined) next.jump_host_id = patch.jump_host_id ?? null;
  if (patch.group_name !== undefined) next.group_name = patch.group_name ?? null;
  if (patch.tags !== undefined) next.tags_json = JSON.stringify(patch.tags ?? []);
  if (patch.agent_forwarding !== undefined) next.agent_forwarding = patch.agent_forwarding ? 1 : 0;
  if (patch.keepalive_secs !== undefined) next.keepalive_secs = patch.keepalive_secs ?? null;
  if (patch.known_host_sha256 !== undefined) next.known_host_sha256 = patch.known_host_sha256 ?? null;
  if (patch.startup_snippet_id !== undefined) next.startup_snippet_id = patch.startup_snippet_id ?? null;
  if (patch.last_used_at !== undefined) next.last_used_at = patch.last_used_at ?? null;
  if (patch.sort_order !== undefined) next.sort_order = patch.sort_order;
  return next;
}
