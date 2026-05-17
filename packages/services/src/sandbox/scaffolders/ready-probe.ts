/**
 * Shared helpers for polling a dev-server port from inside the sandbox
 * container. Originally inlined in `ViteScaffolderBase`; factored out so
 * non-Vite scaffolders (Angular, future stacks) don't copy the probe.
 */

import type { ScaffoldContext } from './scaffolder-port.js';

/**
 * Returns `true` once a process inside the container is bound to
 * `ctx.devServerPort`. Uses an `ss -ltn` probe — cheap, container-only,
 * and authoritative for our purpose (we only care whether the dev server
 * has opened the port; the proxy reaches the container via the
 * driver-mapped host port regardless).
 */
export async function probeContainerReady(ctx: ScaffoldContext): Promise<boolean> {
  try {
    const res = await ctx.driver.exec(
      ctx.containerId,
      `ss -ltn 2>/dev/null | awk '{print $4}' | grep -E ':${ctx.devServerPort}$' >/dev/null && echo listening || echo no`,
      { cwd: ctx.workdir, timeoutMs: 2_000 },
    );
    return /listening/.test(res.stdout);
  } catch {
    return false;
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + ` …[+${s.length - max} bytes]` : s;
}

export const POLL_INTERVAL_MS = 500;
