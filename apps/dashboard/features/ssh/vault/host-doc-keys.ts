/**
 * Scope-qualified keys for the vault's host↔document map.
 *
 * WHY this exists: `hostMap` used to be keyed by the bare numeric `host.id`,
 * but `api.listHosts` returns the UNION of central-shared hosts and this
 * project's own hosts, and those two DBs have independent AUTOINCREMENT
 * sequences. Shared host 3 and project host 3 therefore collided on one map
 * entry — one silently overwrote the other on push, and on apply the WRONG
 * host's credentials got written. The routes layer already knows this (it
 * answers 409 `ambiguous` for a bare colliding id) and `sshHostKey` already
 * existed for exactly this; the sync path just never used it.
 *
 * So the map key is `sshHostKey(h)` — `shared:3` / `project:3` — and these
 * helpers convert back to what each consumer needs: a route ref that carries
 * the disambiguating scope, or the bare numeric id for a `jump_host_id` FK.
 */
import type { SshHost, SshHostStorageScope } from '../types.js';

/**
 * A host reference the CRUD routes can disambiguate (`?scope=…`).
 *
 * Carries BOTH `storage_scope` and `is_shared` because that is the shape
 * `api.patchHost`/`deleteHost` accept (`SshHostRouteRef`), and because
 * `sshHostScope` falls back to `is_shared` when the scope is absent — the two
 * must never disagree.
 */
interface HostDocRef {
  id: number;
  is_shared: number;
  storage_scope: SshHostStorageScope;
}

/** `"shared:3"` → `{ id: 3, is_shared: 1, storage_scope: 'shared' }`. */
export function hostRefFromKey(key: string): HostDocRef {
  const sep = key.indexOf(':');
  const scope = sep > 0 ? key.slice(0, sep) : '';
  const id = Number(sep > 0 ? key.slice(sep + 1) : key);
  const shared = scope === 'shared';
  return { id, is_shared: shared ? 1 : 0, storage_scope: shared ? 'shared' : 'project' };
}

/** Bare local id, for writing a `jump_host_id` FK (which is scope-free in the DB). */
export function hostIdFromKey(key: string): number {
  return hostRefFromKey(key).id;
}

/**
 * Which host does this bare `jump_host_id` mean? Mirrors the route's `jumpOk`
 * rule so both sides agree: a SHARED host may only jump through another shared
 * host (a project-local hop wouldn't resolve from other projects), while a
 * local host may jump through its own project's host or through a shared
 * bastion — project first, since that's the narrower scope.
 */
export function resolveJumpHostKey(
  hosts: SshHost[],
  jumpId: number,
  referrerShared: boolean,
  keyOf: (h: SshHost) => string,
): string | undefined {
  const candidates = hosts.filter((h) => h.id === jumpId);
  if (candidates.length === 0) return undefined;
  const shared = candidates.find((h) => !!h.is_shared);
  if (referrerShared) return shared ? keyOf(shared) : undefined;
  const own = candidates.find((h) => !h.is_shared);
  const picked = own ?? shared;
  return picked ? keyOf(picked) : undefined;
}

/**
 * One-time migration of a persisted map written before scoping existed.
 *
 * Legacy keys are bare numbers. They are re-keyed to `project:<id>`, which is
 * right for the overwhelming majority (a host is project-local unless
 * explicitly shared). A legacy key that actually belonged to a SHARED host
 * mis-migrates: that host then mints a fresh clientDocId on the next push and
 * the old cloud document is orphaned. That is a stray doc, never data loss —
 * and it beats the alternative of dropping the map, which would re-upload every
 * host on every device as a brand-new document.
 */
export function migrateHostMapKeys(map: Record<string, string>): Record<string, string> {
  let changed = false;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(map)) {
    if (/^\d+$/.test(k)) {
      changed = true;
      // Never clobber an already-scoped entry for the same host.
      const scoped = `project:${k}`;
      if (!(scoped in map)) out[scoped] = v;
    } else {
      out[k] = v;
    }
  }
  return changed ? out : map;
}
