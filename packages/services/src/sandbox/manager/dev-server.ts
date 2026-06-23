/**
 * Pure helpers for booting / probing the dev server inside a sandbox
 * container.
 *
 * Extracted from `SandboxManager` private methods so the shell-command
 * synthesis and log-readiness regex can be unit-tested in isolation —
 * a regression here is invisible in normal use but causes the preview
 * iframe to spin forever.
 */
import type { SandboxStack } from '@mcp/services/sandbox/types.js';

/**
 * The shell command we exec to boot the dev server (Vite, Wrangler,
 * etc.) inside a freshly-provisioned container. Output is redirected
 * to `/tmp/dev-server.log` so the manager's tail/log routes can
 * surface it through the dashboard.
 */
export function buildDevServerCommand(stack: SandboxStack, port: number): string {
  if (stack === 'cf-worker') {
    return (
      `nohup npx wrangler dev --ip 0.0.0.0 --port ${port} --local ` +
      `--show-interactive-dev-session=false > /tmp/dev-server.log 2>&1 &`
    );
  }
  return `nohup npm run dev -- --host 0.0.0.0 --port ${port} > /tmp/dev-server.log 2>&1 &`;
}

/**
 * Heuristic that decides "the dev server is up and serving" from the
 * tail of its log. Matches the canonical ready banners of Vite
 * (`Local:`, `Network:`, `ready in N`), Wrangler (`Watch mode enabled`),
 * and Angular (`Application bundle generation complete`). The match
 * is case-insensitive because some frameworks reformat across versions.
 */
export function devServerLogLooksReady(log: string): boolean {
  return /(?:Local:\s+http|Network:\s+http|Watch mode enabled|Application bundle generation complete|ready in \d)/i.test(
    log,
  );
}
