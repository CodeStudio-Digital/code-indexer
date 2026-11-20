/**
 * Regression — toggling "share across projects" on a saved SSH host used to
 * flip `is_shared` IN PLACE on whichever DB held the row. Because the list
 * endpoint unions `[centralStore.listSharedHosts(), projectStore.listHosts()]`
 * — and those queries are mutually exclusive on `is_shared` (0 vs 1) — the
 * row ended up excluded from BOTH lists and silently vanished from the UI
 * ("Nenhum host salvo ainda"). The fix MOVES the row between the two DBs on
 * toggle, preserving its id so `saved:<id>` terminal refs and jump-host FKs
 * keep resolving.
 *
 * NOTE: DB-backed (better-sqlite3). In an environment with a native ABI
 * mismatch (ERR_DLOPEN_FAILED 146 vs 127) run `pnpm node:rebuild` first —
 * the IDE's own indexer may lock the .node file, in which case close the
 * dashboard dev server before rebuilding.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import type DatabaseConstructor from 'better-sqlite3';
import { HttpRouter } from '@mcp/shared/http/router.js';
import { sshHosts173 } from '@mcp/store/migrations/173_ssh_hosts.js';
import { sshHostShared198 } from '@mcp/store/migrations/198_ssh_host_shared.js';
import { SshStore } from '@mcp/store/ssh-store.js';
import { mountSshHostRoutes } from '../hosts.routes.js';
import type { ServerDeps } from '../../../deps.js';
import type { SshHost } from '@mcp/store/ssh-store-types.js';

type DB = InstanceType<typeof DatabaseConstructor>;

interface Handle {
  app: HttpRouter;
  central: SshStore;
  project: SshStore;
  centralDb: DB;
  projectDb: DB;
}

function setup(): Handle {
  const centralDb = new Database(':memory:') as DB;
  const projectDb = new Database(':memory:') as DB;
  sshHosts173.up(centralDb);
  sshHostShared198.up(centralDb);
  sshHosts173.up(projectDb);
  sshHostShared198.up(projectDb);

  const central = new SshStore(centralDb);
  const project = new SshStore(projectDb);

  const app = new HttpRouter();
  // The routes only touch these two deps fields (see sharedOrOwnedHost).
  const deps = { sshStore: central, sshStoreFor: () => project } as unknown as ServerDeps;
  mountSshHostRoutes(app, deps);
  return { app, central, project, centralDb, projectDb };
}

function teardown(h: Handle): void {
  try { h.centralDb.close(); } catch { /* */ }
  try { h.projectDb.close(); } catch { /* */ }
}

const PID = 7;
const j = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

describe('ssh host routes — is_shared toggle relocates the row between stores', () => {
  let h: Handle;
  beforeEach(() => { h = setup(); });
  afterEach(() => teardown(h));

  /** Create a LOCAL host via POST (the path the HostEditDialog "new" uses). */
  async function createLocal(label: string): Promise<SshHost> {
    const r = await h.app.request(`/api/projects/${PID}/ssh/hosts`, j('POST', {
      label,
      hostname: 'example.com',
      port: 22,
      username: 'root',
      auth_method: 'agent',
      agent_forwarding: false,
      is_shared: false,
    }));
    expect(r.status).toBe(200);
    return (await r.json()) as SshHost;
  }

  async function listHosts(): Promise<SshHost[]> {
    const r = await h.app.request(`/api/projects/${PID}/ssh/hosts`);
    expect(r.status).toBe(200);
    return ((await r.json()) as { hosts: SshHost[] }).hosts;
  }

  async function patchHost(hid: number, patch: Record<string, unknown>, scope?: 'shared' | 'project'): Promise<SshHost> {
    const qs = scope ? `?scope=${scope}` : '';
    const r = await h.app.request(`/api/projects/${PID}/ssh/hosts/${hid}${qs}`, j('PATCH', patch));
    expect(r.status).toBe(200);
    return (await r.json()) as SshHost;
  }

  async function deleteHost(hid: number, scope?: 'shared' | 'project'): Promise<void> {
    const qs = scope ? `?scope=${scope}` : '';
    const r = await h.app.request(`/api/projects/${PID}/ssh/hosts/${hid}${qs}`, { method: 'DELETE' });
    expect(r.status).toBe(200);
  }

  it('local → shared: PATCH {is_shared:true} moves the row into the central store', async () => {
    const created = await createLocal('bastion');
    expect(created.is_shared).toBe(0);
    expect(h.project.listHosts(PID).map((x) => x.label)).toEqual(['bastion']);
    expect(h.central.listSharedHosts()).toEqual([]);

    // The exact bug repro: edit + toggle "share across projects".
    const patched = await patchHost(created.id, { is_shared: true });

    expect(patched.id).toBe(created.id); // id preserved
    expect(patched.is_shared).toBe(1);
    // Row physically moved: gone from the project DB, present in the central DB.
    expect(h.project.listHosts(PID)).toEqual([]);
    expect(h.central.listSharedHosts().map((x) => x.label)).toEqual(['bastion']);
    // The LIST endpoint (the union the UI reads) now sees it as shared.
    expect(listHostsPipe(await listHosts())).toEqual(['bastion']);
  });

  it('shared → local: PATCH {is_shared:false} moves the row back to the project store', async () => {
    // Start from a shared host (create directly in the central store).
    const shared = h.central.createHost({
      project_id: PID, label: 'shared-bastion', hostname: 'ex.com',
      port: 22, username: 'root', auth_method: 'agent', is_shared: true,
    });
    expect(h.central.listSharedHosts()).toHaveLength(1);
    expect(h.project.listHosts(PID)).toEqual([]);

    const patched = await patchHost(shared.id, { is_shared: false });

    expect(patched.id).toBe(shared.id);
    expect(patched.is_shared).toBe(0);
    expect(h.central.listSharedHosts()).toEqual([]);
    expect(h.project.listHosts(PID).map((x) => x.label)).toEqual(['shared-bastion']);
  });

  it('shared → local is REJECTED from a non-origin project (403)', async () => {
    // A shared host whose origin project is PID (7). Call from project 99 — the
    // row must NOT move into project 99's store (it would be stranded: deleted
    // from central, invisible to project 7's list, and foreign to 99's filter).
    const shared = h.central.createHost({
      project_id: PID, label: 'origin-7', hostname: 'ex.com',
      port: 22, username: 'root', auth_method: 'agent', is_shared: true,
    });
    const r = await h.app.request(
      `/api/projects/99/ssh/hosts/${shared.id}`,
      j('PATCH', { is_shared: false }),
    );
    expect(r.status).toBe(403);
    // Row untouched in the central store.
    expect(h.central.getHost(shared.id)?.is_shared).toBe(1);
    expect(h.central.listSharedHosts().map((x) => x.label)).toEqual(['origin-7']);
  });

  it('a non-toggling PATCH (rename) stays in its store and does not move', async () => {
    const created = await createLocal('to-rename');
    await patchHost(created.id, { label: 'renamed' });

    // Still local — never moved to the central store.
    expect(h.central.listSharedHosts()).toEqual([]);
    expect(h.project.listHosts(PID).map((x) => x.label)).toEqual(['renamed']);
  });

  it('a toggle + field change in one PATCH applies the field to the relocated row', async () => {
    const created = await createLocal('multi');
    const patched = await patchHost(created.id, { is_shared: true, label: 'multi-shared' });

    expect(patched.is_shared).toBe(1);
    expect(patched.label).toBe('multi-shared'); // co-patched field landed on the MOVED row
    expect(h.central.getHost(created.id)?.label).toBe('multi-shared');
    expect(h.project.listHosts(PID)).toEqual([]);
  });

  it('preserves the TOFU known_host_sha256 across a toggle (no re-trust)', async () => {
    const created = await createLocal('tofu');
    // Pin a host key (as the TOFU flow would). Cast: known_host_sha256 is a
    // writable column (in WRITABLE_COLUMNS) but not on SshHostPatch since the
    // TOFU flow persists it via manager.trust(), not the PATCH route.
    h.project.updateHost(created.id, { known_host_sha256: 'sha256:deadbeef' } as unknown as Parameters<typeof h.project.updateHost>[1]);
    expect(h.project.getHost(created.id)?.known_host_sha256).toBe('sha256:deadbeef');

    const patched = await patchHost(created.id, { is_shared: true });

    expect(patched.known_host_sha256).toBe('sha256:deadbeef'); // traveled with the row
    expect(h.central.getHost(created.id)?.known_host_sha256).toBe('sha256:deadbeef');
  });

  it('a toggle + tags change in one PATCH normalizes tags → tags_json on the moved row', async () => {
    // `tags` is an array in the patch but stored as `tags_json` (string); the
    // merge must translate it or the relocated row keeps stale tags.
    const created = await createLocal('taggy');
    expect(created.tags_json).toBe('[]');

    const patched = await patchHost(created.id, { is_shared: true, tags: ['prod', 'bastion'] } as Record<string, unknown>);

    expect(patched.is_shared).toBe(1);
    expect(patched.tags_json).toBe(JSON.stringify(['prod', 'bastion']));
    expect(h.central.getHost(created.id)?.tags_json).toBe(JSON.stringify(['prod', 'bastion']));
    expect(h.project.listHosts(PID)).toEqual([]);
  });

  it('uses storage scope to avoid PATCH/DELETE hitting the wrong host when ids collide', async () => {
    const shared = h.central.createHost({
      project_id: PID, label: 'shared-collision', hostname: 'shared.example',
      port: 22, username: 'root', auth_method: 'agent', is_shared: true,
    });
    const local = await createLocal('local-collision');
    expect(local.id).toBe(shared.id); // independent DBs can reuse the same numeric id

    const listed = (await listHosts()) as Array<SshHost & { storage_scope?: string }>;
    expect(listed.map((x) => `${x.storage_scope}:${x.id}:${x.label}`)).toEqual([
      `shared:${shared.id}:shared-collision`,
      `project:${local.id}:local-collision`,
    ]);

    const ambiguous = await h.app.request(`/api/projects/${PID}/ssh/hosts/${local.id}`, j('PATCH', { label: 'wrong' }));
    expect(ambiguous.status).toBe(409);
    expect(h.central.getHost(shared.id)?.label).toBe('shared-collision');
    expect(h.project.getHost(local.id)?.label).toBe('local-collision');

    await patchHost(local.id, { label: 'local-renamed' }, 'project');
    expect(h.project.getHost(local.id)?.label).toBe('local-renamed');
    expect(h.central.getHost(shared.id)?.label).toBe('shared-collision');

    await deleteHost(local.id, 'project');
    expect(h.project.getHost(local.id)).toBeNull();
    expect(h.central.getHost(shared.id)?.label).toBe('shared-collision');

    await deleteHost(shared.id, 'shared');
    expect(h.central.getHost(shared.id)).toBeNull();
  });
});

/** Flatten the host list to labels for easy assertion. */
function listHostsPipe(hosts: SshHost[]): string[] {
  return hosts.map((x) => x.label);
}
