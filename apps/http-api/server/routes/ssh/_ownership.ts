import type { SshStore } from '@mcp/store/ssh-store.js';
import type { SshHost, SshIdentity, SshSnippet, SshSecret } from '@mcp/store/ssh-store-types.js';
import type { ServerDeps } from '../../deps.js';

export type SshHostStorageScope = 'shared' | 'project';

export type ScopedSshHost = SshHost & { storage_scope: SshHostStorageScope };

export interface ResolvedSshHost {
  host: SshHost;
  store: SshStore;
  storage_scope: SshHostStorageScope;
}

export interface AmbiguousSshHost {
  ambiguous: true;
}

/**
 * Cross-project ownership guards for the SSH routes.
 *
 * Hosts/identities are looked up by their OWN row id (ids are NOT project-
 * scoped), so after an in-place project switch the client could hold a stale id
 * from a different project. Without these guards a stale id would let one
 * project read or mutate another project's saved host — including its encrypted
 * credentials. Every `:hid`/`:iid` handler must resolve ownership here and treat
 * a mismatch as "not found". Mirrors the api-client `_ownership.ts` model.
 */

export function hostInProject(store: SshStore, projectId: number, hid: number): SshHost | null {
  const h = store.getHost(hid);
  return h && h.project_id === projectId ? h : null;
}

export function identityInProject(store: SshStore, projectId: number, iid: number): SshIdentity | null {
  const ident = store.getIdentity(iid);
  return ident && ident.project_id === projectId ? ident : null;
}

export function snippetInProject(store: SshStore, projectId: number, sid: number): SshSnippet | null {
  const sn = store.getSnippet(sid);
  return sn && sn.project_id === projectId ? sn : null;
}

export function secretInProject(store: SshStore, projectId: number, secId: number): SshSecret | null {
  const s = store.getSecret(secId);
  return s && s.project_id === projectId ? s : null;
}

export function withHostStorageScope(host: SshHost, storage_scope: SshHostStorageScope): ScopedSshHost {
  return { ...host, storage_scope };
}

/**
 * Resolve a host id to its row + the store it lives in, for GET/PATCH/DELETE.
 * A SHARED host (`is_shared=1`) lives in the CENTRAL DB and is reachable from
 * ANY project; otherwise the host must belong to `projectId`. Returns null
 * (→ 404) for a stale/foreign id — so ops on a shared host route to the central
 * store (and thus reflect in every project).
 */
export function resolveSharedOrOwnedHost(
  deps: Pick<ServerDeps, 'sshStore' | 'sshStoreFor'>,
  projectId: number,
  hid: number,
  scope?: SshHostStorageScope,
): ResolvedSshHost | AmbiguousSshHost | null {
  const shared = deps.sshStore.getHost(hid);
  const store = deps.sshStoreFor(projectId);
  const own = store.getHost(hid);
  const sharedFound: ResolvedSshHost | null = shared && shared.is_shared
    ? { host: shared, store: deps.sshStore, storage_scope: 'shared' }
    : null;
  const ownFound: ResolvedSshHost | null = own && own.project_id === projectId && !own.is_shared
    ? { host: own, store, storage_scope: 'project' }
    : null;

  if (scope === 'shared') return sharedFound;
  if (scope === 'project') return ownFound;
  if (sharedFound && ownFound) return { ambiguous: true };
  return sharedFound ?? ownFound;
}

export function sharedOrOwnedHost(
  deps: Pick<ServerDeps, 'sshStore' | 'sshStoreFor'>,
  projectId: number,
  hid: number,
): ResolvedSshHost | null {
  const found = resolveSharedOrOwnedHost(deps, projectId, hid);
  return found && !('ambiguous' in found) ? found : null;
}
