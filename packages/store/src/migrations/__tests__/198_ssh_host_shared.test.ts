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
});
