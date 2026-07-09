/**
 * Migration 198 — ssh_host_shared + the SshStore behaviour it enables.
 *
 * Pins: is_shared column added (default 0) + idempotent; project-scoped
 * `listHosts` EXCLUDES shared hosts; `listSharedHosts` returns them regardless
 * of project; `updateHost` can toggle is_shared (the PATCH path).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import type DatabaseConstructor from 'better-sqlite3';
import { sshHosts173 } from '../173_ssh_hosts.js';
import { sshHostShared198 } from '../198_ssh_host_shared.js';
import { SshStore } from '../../ssh-store.js';

type DB = InstanceType<typeof DatabaseConstructor>;
let db: DB;

beforeEach(() => {
  db = new Database(':memory:');
  sshHosts173.up(db);
  sshHostShared198.up(db);
});
afterEach(() => db.close());

const baseHost = (over: Partial<{ project_id: number; label: string; is_shared: boolean }> = {}) => ({
  project_id: 1,
  label: 'srv',
  hostname: 'example.com',
  username: 'root',
  auth_method: 'agent' as const,
  ...over,
});

describe('migration 198 — ssh_host_shared', () => {
  it('adds the is_shared column (default 0) and is idempotent', () => {
    const cols = (db.prepare('PRAGMA table_info(ssh_hosts)').all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toContain('is_shared');
    expect(() => sshHostShared198.up(db)).not.toThrow();
  });
});

describe('SshStore — shared hosts', () => {
  it('listHosts excludes shared; listSharedHosts returns only shared', () => {
    const store = new SshStore(db);
    store.createHost(baseHost({ project_id: 1, label: 'local-1' }));
    const shared = store.createHost(baseHost({ project_id: 1, label: 'shared-1', is_shared: true }));

    expect(store.listHosts(1).map((h) => h.label)).toEqual(['local-1']);
    const sharedList = store.listSharedHosts();
    expect(sharedList.map((h) => h.label)).toEqual(['shared-1']);
    expect(sharedList[0].is_shared).toBe(1);
    expect(shared.is_shared).toBe(1);
  });

  it('a shared host is visible from any project (listSharedHosts is project-agnostic)', () => {
    const store = new SshStore(db);
    store.createHost(baseHost({ project_id: 5, label: 'bastion', is_shared: true }));
    expect(store.listHosts(7)).toEqual([]); // project 7 has no own hosts…
    expect(store.listSharedHosts().map((h) => h.label)).toEqual(['bastion']); // …but sees the shared one
  });

  it('updateHost toggles is_shared (the PATCH path)', () => {
    const store = new SshStore(db);
    const h = store.createHost(baseHost({ project_id: 1, label: 'toggle' }));
    expect(store.listHosts(1)).toHaveLength(1);
    store.updateHost(h.id, { is_shared: true });
    expect(store.listHosts(1)).toHaveLength(0); // excluded from own once shared
    expect(store.listSharedHosts().map((x) => x.label)).toEqual(['toggle']);
  });

  // The dual-DB regression: toggling is_shared must RELOCATE the row between the
  // project store and the central store (not just flip the flag in place), or the
  // host vanishes from both lists — `listHosts` filters `is_shared = 0` and the
  // central `listSharedHosts` only reads its own DB. This is the exact bug behind
  // "edit a saved host, mark share-across-projects, and it disappears from the list".
  it('createHostWithId relocates a row between two stores preserving id + TOFU hash', () => {
    const projectDb = new Database(':memory:') as DB;
    const centralDb = new Database(':memory:') as DB;
    sshHosts173.up(projectDb);
    sshHostShared198.up(projectDb);
    sshHosts173.up(centralDb);
    sshHostShared198.up(centralDb);
    const projectStore = new SshStore(projectDb);
    const centralStore = new SshStore(centralDb);

    // A local host in the project DB, with a pinned host key (TOFU trust).
    const local = projectStore.createHost(baseHost({ project_id: 7, label: 'bastion' }));
    // Pin a host key (as the TOFU flow would). Cast: known_host_sha256 is a
    // writable column but not on SshHostPatch (the TOFU flow persists it via
    // manager.trust(), not the PATCH route).
    projectStore.updateHost(local.id, { known_host_sha256: 'sha256:abc' } as unknown as Parameters<typeof projectStore.updateHost>[1]);
    const before = projectStore.getHost(local.id)!;
    expect(before.is_shared).toBe(0);
    expect(before.known_host_sha256).toBe('sha256:abc');

    // local → shared: move into the central DB, preserving id + TOFU hash.
    const moved = centralStore.createHostWithId({ ...before, is_shared: 1 });
    projectStore.deleteHost(local.id);

    expect(moved.id).toBe(local.id); // id preserved → saved:<id> refs survive
    expect(moved.is_shared).toBe(1);
    expect(moved.known_host_sha256).toBe('sha256:abc'); // TOFU trust travels
    expect(moved.project_id).toBe(7); // origin project preserved
    // The host is now visible to ALL projects via the central store, and gone
    // from the project store's local list.
    expect(projectStore.listHosts(7)).toEqual([]);
    expect(centralStore.listSharedHosts().map((h) => h.label)).toEqual(['bastion']);

    // shared → local: move back into the project DB, still preserving id + TOFU.
    const back = projectStore.createHostWithId({ ...centralStore.getHost(local.id)!, is_shared: 0 });
    centralStore.deleteHost(local.id);
    expect(back.id).toBe(local.id);
    expect(back.is_shared).toBe(0);
    expect(back.known_host_sha256).toBe('sha256:abc');
    expect(projectStore.listHosts(7).map((h) => h.label)).toEqual(['bastion']);
    expect(centralStore.listSharedHosts()).toEqual([]);

    projectDb.close();
    centralDb.close();
  });
});