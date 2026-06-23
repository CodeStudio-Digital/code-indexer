/**
 * Dev-server runtime helpers — the shell commands and HTTP probes used
 * to relaunch / wait-for-ready the dev server inside a running sandbox
 * container.
 *
 * Extracted from `SandboxManager`'s `relaunchDevServer`,
 * `waitForPublishedHttp`, `readDevServerLog`, and
 * `captureContainerDiagnostic` private methods so:
 *   - The readiness-detection heuristic (port probe + log scan + HTTP
 *     fetch) is unit-testable in isolation.
 *   - The diagnostic-on-failure path runs the same regardless of which
 *     SandboxManager method discovered the timeout.
 *   - Refactors of the manager don't need to thread the dev-server
 *     state through provision/resume/start paths.
 */
import type { Sandbox } from '@mcp/services/sandbox/types.js';
import type { ISandboxDriver } from '@mcp/services/sandbox/ports/sandbox-driver.js';
import {
  buildDevServerCommand,
  devServerLogLooksReady,
} from '@mcp/services/sandbox/manager/dev-server.js';

/**
 * Capture a snapshot of the container's recent failure mode — exit code,
 * OOM flag, and the last 100 log lines. Used as a "why did it die?"
 * post-mortem appended to the error a caller throws.
 *
 * Best-effort: a driver failure here NEVER throws; an empty string is
 * returned so the original error stays unobscured.
 */
export async function captureContainerDiagnostic(
  driver: ISandboxDriver,
  containerId: string,
): Promise<string> {
  try {
    const [state, logs] = await Promise.all([
      driver.getContainerState(containerId).catch(() => null),
      driver.getContainerLogs(containerId, 100).catch(() => ''),
    ]);
    const parts: string[] = [];
    if (state) {
      parts.push(
        `Container state: exitCode=${state.exitCode ?? 'null'} ` +
          `oomKilled=${state.oomKilled} ` +
          (state.error ? `error=${JSON.stringify(state.error)} ` : '') +
          (state.finishedAt ? `finishedAt=${state.finishedAt}` : ''),
      );
    }
    if (logs) parts.push(`--- last logs ---\n${logs}`);
    return parts.join('\n');
  } catch {
    return '';
  }
}

/** Tail the dev-server log file inside the container; empty on failure. */
export async function readDevServerLog(
  driver: ISandboxDriver,
  sb: Sandbox,
  lines: number,
): Promise<string> {
  if (!sb.containerId) return '';
  try {
    const res = await driver.exec(
      sb.containerId,
      `tail -n ${lines} /tmp/dev-server.log || true`,
      { cwd: sb.workdir, timeoutMs: 5_000 },
    );
    return res.stdout;
  } catch {
    return '';
  }
}

/**
 * Spawn the dev-server inside a running container and poll until the
 * expected port comes up (timeout 60s). Throws with a precise error
 * message on failure so callers can surface it to the user.
 *
 * Note: this is the SCAFFOLDED-STACK path (Vite, Wrangler). External
 * Node projects with their own package.json scripts use a different
 * relaunch path (see `external-node-runtime.ts`).
 */
export async function relaunchDevServer(
  driver: ISandboxDriver,
  containerId: string,
  workdir: string,
  stack: Sandbox['stack'],
  devServerPort: number,
  signal?: AbortSignal,
): Promise<void> {
  const cmd = buildDevServerCommand(stack, devServerPort);
  const spawnRes = await driver.exec(containerId, cmd, {
    cwd: workdir,
    timeoutMs: 10_000,
    signal,
  });
  if (spawnRes.exitCode !== 0) {
    throw new Error(`failed to relaunch dev server: ${spawnRes.stderr || spawnRes.stdout}`);
  }
  // Poll the in-container `ss` for the expected port, mirroring the
  // scaffolder's readiness check. 60s is enough even on cold cache
  // because deps are already installed.
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error('relaunch aborted');
    const probe = await driver.exec(
      containerId,
      `ss -ltn 2>/dev/null | awk '{print $4}' | grep -E ':${devServerPort}$' >/dev/null && echo listening || echo no`,
      { cwd: workdir, timeoutMs: 2_000 },
    );
    if (/listening/.test(probe.stdout)) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('relaunched dev server failed to bind port');
}

/**
 * Wait until the dev server's host port answers an HTTP request OR the
 * scaffolder's banner appears in the log. Combines port-listening
 * check + HTTP fetch + log-banner scan because no single signal is
 * 100% reliable across all stacks/states.
 *
 * On timeout, throws a rich error containing the dev-server log tail
 * and the container's diagnostic snapshot — operators see exactly why
 * the start failed without needing to shell in.
 */
export async function waitForPublishedHttp(
  driver: ISandboxDriver,
  sb: Sandbox,
  path: string,
  options?: {
    signal?: AbortSignal;
    label?: string;
    timeoutMs?: number;
  },
): Promise<void> {
  const { signal, label = 'Project container', timeoutMs = 120_000 } = options ?? {};
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  const deadline = Date.now() + timeoutMs;
  let lastError = '';
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error(`${label} start aborted`);
    if (await driver.isPortListening(sb.hostPort)) {
      try {
        const remainingMs = Math.max(1_000, deadline - Date.now());
        const requestTimeoutMs = Math.min(15_000, remainingMs);
        const res = await fetch(`http://127.0.0.1:${sb.hostPort}${normalizedPath}`, {
          redirect: 'manual',
          signal: AbortSignal.timeout(requestTimeoutMs),
        });
        if (res.status < 500) return;
        lastError = `HTTP ${res.status}`;
      } catch (e) {
        lastError = e instanceof Error ? e.message : String(e);
      }
      const readyLog = await readDevServerLog(driver, sb, 60);
      if (devServerLogLooksReady(readyLog)) return;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  const [diagnostic, devLog] = sb.containerId
    ? await Promise.all([
        captureContainerDiagnostic(driver, sb.containerId),
        readDevServerLog(driver, sb, 80),
      ])
    : ['', ''];
  throw new Error(
    `${label} did not return HTTP on host port ${sb.hostPort} -> container port ${sb.containerPort}${normalizedPath} within ${timeoutMs}ms.` +
      (lastError ? ` Last error: ${lastError}.` : '') +
      (devLog ? `\n\n--- dev-server log ---\n${devLog}` : '') +
      (diagnostic ? `\n\n${diagnostic}` : ''),
  );
}
