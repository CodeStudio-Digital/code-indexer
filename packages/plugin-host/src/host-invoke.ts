/**
 * The reverse-RPC choke point. Every `ctx.fs` / `ctx.exec` / `ctx.storage`
 * call a plugin tool makes is forwarded here (over the worker `host` frame,
 * tagged with the plugin's namespace + project cwd). This is the SINGLE place
 * privileged operations execute, and it re-checks the user-granted permission
 * set per call (defense in depth) before dispatching to a capability handler.
 * Anything off the switch is denied.
 *
 * `resolveGrants` reads the approved subset (installed_plugins.permissions_
 * granted); `readOnlyApi` (optional) handles the pre-existing read-only
 * `host.*` api-bus surface (projects.list, files.read, …).
 */
import type { PluginPermissions } from '@mcp/plugin-sdk';
import type { PluginStorageStore } from '@mcp/store/plugin-storage-store.js';
import { handleFs } from './capabilities/fs.js';
import { handleExec } from './capabilities/exec.js';
import { handleStorage } from './capabilities/storage.js';

export interface HostInvokeDeps {
  /** Approved capability subset for a namespace (null = nothing granted). */
  resolveGrants(namespace: string): PluginPermissions | null;
  /** Backing store for the storage capability. */
  storage: PluginStorageStore;
  /** Optional passthrough for whitelisted read-only api-bus methods. */
  readOnlyApi?(method: string, payload: unknown): Promise<unknown>;
}

export type HostInvoke = (
  method: string,
  payload: unknown,
  namespace: string,
  cwd: string,
) => Promise<unknown>;

export function buildHostInvoke(deps: HostInvokeDeps): HostInvoke {
  return async (method, payload, namespace, cwd) => {
    const grants = deps.resolveGrants(namespace) ?? {};
    if (method.startsWith('fs.')) return handleFs(method, payload, cwd, grants.fs);
    if (method === 'exec.run') return handleExec(payload, cwd, grants.exec);
    if (method.startsWith('storage.')) {
      return handleStorage(method, payload, namespace, deps.storage, !!grants.storage);
    }
    if (deps.readOnlyApi) return deps.readOnlyApi(method, payload);
    throw new Error(`permission_denied: method not allowed: ${method}`);
  };
}
