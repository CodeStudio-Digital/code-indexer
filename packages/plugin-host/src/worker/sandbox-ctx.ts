/**
 * Build the restricted context handed to a plugin tool handler. The worker
 * thread provides isolation; this shapes the *surface* a handler sees —
 * fetch + log + a reverse-RPC `host.invoke`, but no fs/child_process handed
 * in. (Hard sandboxing via Node's permission model is a future hardening
 * step — worker_threads isolate crashes/memory, not filesystem access.)
 */
import type { PluginToolContext } from '@mcp/plugin-sdk';

export interface SandboxDeps {
  projectName: string | null;
  cwd: string;
  signal?: AbortSignal;
  log(message: string): void;
  /** Reverse-RPC into the host's whitelisted (read-only) api-bus surface. */
  hostInvoke(method: string, payload?: unknown): Promise<unknown>;
}

export function buildSandboxContext(deps: SandboxDeps): PluginToolContext {
  return {
    projectName: deps.projectName,
    cwd: deps.cwd,
    signal: deps.signal,
    log: deps.log,
    fetch: globalThis.fetch,
    host: { invoke: deps.hostInvoke },
  };
}
