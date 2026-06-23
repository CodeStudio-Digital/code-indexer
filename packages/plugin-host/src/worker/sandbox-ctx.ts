/**
 * Build the restricted context handed to a plugin tool handler. The worker
 * thread provides isolation; this shapes the *surface* a handler sees:
 * fetch + log + a reverse-RPC `host.invoke`, plus the gated capability proxies
 * (`fs`/`exec`/`storage`). Each proxy just forwards over the same reverse-RPC
 * to the host, where permissions are ACTUALLY enforced (plugin-host/
 * host-invoke.ts re-checks the user-granted set per call). Proxies are always
 * attached here; the host denies un-granted calls with `permission_denied`.
 *
 * `deps.hostInvoke` is pre-bound by the worker to this invocation's namespace
 * + project cwd, so this module stays agnostic of which plugin is calling.
 */
import type { PluginToolContext, PluginExecResult } from '@mcp/plugin-sdk';

export interface SandboxDeps {
  projectName: string | null;
  cwd: string;
  signal?: AbortSignal;
  log(message: string): void;
  /** Reverse-RPC into the host, pre-bound to this invocation's namespace+cwd. */
  hostInvoke(method: string, payload?: unknown): Promise<unknown>;
}

export function buildSandboxContext(deps: SandboxDeps): PluginToolContext {
  const invoke = deps.hostInvoke;
  return {
    projectName: deps.projectName,
    cwd: deps.cwd,
    signal: deps.signal,
    log: deps.log,
    fetch: globalThis.fetch,
    host: { invoke },
    fs: {
      readFile: (path) => invoke('fs.readFile', { path }) as Promise<string>,
      writeFile: (path, content) =>
        invoke('fs.writeFile', { path, content }).then(() => undefined),
      readdir: (path) => invoke('fs.readdir', { path }) as Promise<string[]>,
      exists: (path) => invoke('fs.exists', { path }) as Promise<boolean>,
    },
    exec: {
      run: (cmd, args, opts) =>
        invoke('exec.run', { cmd, args, ...(opts ?? {}) }) as Promise<PluginExecResult>,
    },
    storage: {
      get: (key) => invoke('storage.get', { key }) as Promise<string | null>,
      set: (key, value) => invoke('storage.set', { key, value }).then(() => undefined),
      delete: (key) => invoke('storage.delete', { key }).then(() => undefined),
      list: () => invoke('storage.list', {}) as Promise<string[]>,
    },
  };
}
