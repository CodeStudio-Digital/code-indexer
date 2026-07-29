/**
 * Regression — the vault's host↔document map was keyed by the bare numeric
 * `host.id`, but `api.listHosts` returns the UNION of central-shared hosts and
 * this project's own hosts, and those two DBs have independent AUTOINCREMENT
 * sequences. Shared host 3 and project host 3 therefore collapsed onto ONE map
 * entry: one silently overwrote the other on push, and on apply the WRONG
 * host's credentials were written to the wrong server. Keys are now
 * scope-qualified (`shared:3` / `project:3`).
 */
import { describe, expect, it } from 'vitest';
import { hostIdFromKey, hostRefFromKey, migrateHostMapKeys, resolveJumpHostKey } from '../host-doc-keys.js';
import { sshHostKey } from '../../api.js';
import type { SshHost } from '../../types.js';

const host = (id: number, is_shared: 0 | 1, extra: Partial<SshHost> = {}): SshHost =>
  ({
    id,
    is_shared,
    storage_scope: is_shared ? 'shared' : 'project',
    label: `h${id}`,
    hostname: 'ex.com',
    port: 22,
    username: 'root',
    ...extra,
  }) as SshHost;

describe('host doc keys — scope disambiguation', () => {
  it('a shared host and a project host with the SAME id get distinct keys', () => {
    const shared = host(3, 1);
    const project = host(3, 0);
    expect(sshHostKey(shared)).toBe('shared:3');
    expect(sshHostKey(project)).toBe('project:3');
    expect(sshHostKey(shared)).not.toBe(sshHostKey(project));

    // …so they mint independent clientDocIds instead of clobbering each other.
    const map: Record<string, string> = {};
    for (const h of [shared, project]) map[sshHostKey(h)] = `ws1:${h.is_shared ? 'S' : 'P'}`;
    expect(Object.keys(map)).toHaveLength(2);
  });

  it('round-trips a key back into a route ref that carries the scope', () => {
    // `is_shared` rides along because that is the shape the CRUD routes accept
    // (SshHostRouteRef), and `sshHostScope` falls back to it when storage_scope
    // is absent — the two must never disagree.
    expect(hostRefFromKey('shared:3')).toEqual({ id: 3, is_shared: 1, storage_scope: 'shared' });
    expect(hostRefFromKey('project:12')).toEqual({ id: 12, is_shared: 0, storage_scope: 'project' });
    expect(hostIdFromKey('shared:3')).toBe(3);
  });

  it('keeps is_shared and storage_scope consistent for every key', () => {
    for (const k of ['shared:1', 'project:1', '1', 'bogus:1']) {
      const ref = hostRefFromKey(k);
      expect(!!ref.is_shared).toBe(ref.storage_scope === 'shared');
    }
  });

  it('an unscoped key degrades to project (the pre-scoping default), not shared', () => {
    // Fail-safe direction: mislabelling a shared host as project makes it mint a
    // fresh doc; the reverse would let it patch a central row it doesn't own.
    expect(hostRefFromKey('3')).toEqual({ id: 3, is_shared: 0, storage_scope: 'project' });
  });

  describe('jump host resolution mirrors the route jumpOk rule', () => {
    const hosts = [host(11, 1), host(11, 0), host(20, 0)];

    it('a shared host may only jump through another SHARED host', () => {
      expect(resolveJumpHostKey(hosts, 11, true, sshHostKey)).toBe('shared:11');
      // No shared candidate → unresolved, rather than silently using the local one.
      expect(resolveJumpHostKey(hosts, 20, true, sshHostKey)).toBeUndefined();
    });

    it('a local host prefers its own project host, falling back to a shared bastion', () => {
      expect(resolveJumpHostKey(hosts, 11, false, sshHostKey)).toBe('project:11');
      expect(resolveJumpHostKey([host(11, 1)], 11, false, sshHostKey)).toBe('shared:11');
    });

    it('an unknown jump id resolves to undefined', () => {
      expect(resolveJumpHostKey(hosts, 404, false, sshHostKey)).toBeUndefined();
    });
  });

  describe('legacy map migration', () => {
    it('re-keys bare numeric entries as project scope, preserving the docId', () => {
      expect(migrateHostMapKeys({ '3': 'ws1:a', '7': 'ws1:b' })).toEqual({
        'project:3': 'ws1:a',
        'project:7': 'ws1:b',
      });
    });

    it('leaves an already-scoped map untouched (same object, no churn)', () => {
      const scoped = { 'project:3': 'ws1:a', 'shared:3': 'ws1:b' };
      expect(migrateHostMapKeys(scoped)).toBe(scoped);
    });

    it('never clobbers an existing scoped entry with a legacy one', () => {
      const out = migrateHostMapKeys({ '3': 'ws1:legacy', 'project:3': 'ws1:current' });
      expect(out['project:3']).toBe('ws1:current');
    });

    it('is idempotent', () => {
      const once = migrateHostMapKeys({ '3': 'ws1:a' });
      expect(migrateHostMapKeys(once)).toEqual(once);
    });
  });
});
