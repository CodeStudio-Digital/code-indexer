import type { SshStore } from '@mcp/store/ssh-store.js';
import type { SshHost, SshIdentity, SshSnippet } from '@mcp/store/ssh-store-types.js';

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
