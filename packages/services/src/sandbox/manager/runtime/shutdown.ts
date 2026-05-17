/**
 * Install SIGTERM/SIGINT handlers that block until `destroyAll`
 * completes (or `timeoutMs` elapses) so `driver.exportWorkdir` has a
 * chance to finish before Node terminates. Without this, a typical
 * nodemon/systemd 10s SIGKILL would cut off mid-archive and users
 * would lose `node_modules` on every server restart.
 *
 * Timeout cap (env: `MCP_SHUTDOWN_TIMEOUT_MS`, default 8s) keeps us
 * inside the SIGKILL grace window. When the timeout fires we exit
 * anyway and let the next-boot orphan reaper salvage what we left
 * behind. `once` registration so a re-entrant signal doesn't restart
 * the dance.
 */
export function installShutdownHandlers(opts: {
  countSandboxes: () => number;
  destroyAll: (reason: string) => Promise<void>;
  timeoutMs?: number;
}): void {
  const timeoutMs = opts.timeoutMs ?? Number(process.env.MCP_SHUTDOWN_TIMEOUT_MS ?? 8_000);
  const handler = async (signal: NodeJS.Signals) => {
    const n = opts.countSandboxes();
    if (n > 0) {
      console.log(
        `[sandbox-manager] ${signal} received, archiving ${n} sandbox(es) (${timeoutMs}ms budget)…`,
      );
    }
    try {
      await Promise.race([
        opts.destroyAll(`signal:${signal}`),
        new Promise<void>((_, reject) =>
          setTimeout(() => reject(new Error(`shutdown timeout after ${timeoutMs}ms`)), timeoutMs),
        ),
      ]);
    } catch (e) {
      console.warn(
        `[sandbox-manager] shutdown: ${e instanceof Error ? e.message : String(e)} ` +
          `(remaining sandboxes will be salvaged by next-boot reaper)`,
      );
    }
    process.exit(0);
  };
  process.once('SIGTERM', handler);
  process.once('SIGINT', handler);
}
