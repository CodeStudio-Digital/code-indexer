/**
 * ServiceSupervisor probe — gathers the raw facts `health-core.ts` turns
 * into a verdict. Three channels, cheapest first, 2s budget each:
 *
 *   1. HTTP GET on `127.0.0.1:<hostPort>/` — reuses `probeOnce` from the
 *      sandbox readiness probe (single-attempt variant exported for us)
 *      so the HTTP mechanics live in ONE place.
 *   2. `driver.isPortListening(hostPort)` — TCP fallback when HTTP is mute.
 *   3. `driver.inspectContainer` + `driver.getContainerState` — container
 *      liveness + post-mortem (exit code / OOM) for the `detail` column.
 *
 * Every driver call is best-effort: a probe must NEVER throw, because a
 * driver hiccup on one service must not abort the supervisor's tick for
 * the remaining services. Unknowable facts stay `undefined`, which makes
 * `evaluateProbe` hold the previous state.
 */
import { probeOnce } from '@mcp/services/sandbox/local-process/readiness-probe.js';
import type { ProbeOutcome } from './health-core.js';

export const PROBE_TIMEOUT_MS = 2_000;

/** Structural slice of ISandboxDriver — keeps fakes trivial in tests. */
export interface ProbeDriverLike {
  isPortListening(hostPort: number): Promise<boolean>;
  inspectContainer(containerId: string): Promise<{ exists: boolean; running: boolean }>;
  getContainerState(containerId: string): Promise<{
    exitCode: number | null;
    oomKilled: boolean;
    error?: string | null;
  } | null>;
}

export interface ProbeTarget {
  hostPort: number;
  containerId: string | null;
}

export async function probeService(
  driver: ProbeDriverLike,
  target: ProbeTarget,
): Promise<ProbeOutcome> {
  const outcome: ProbeOutcome = {};

  // 1. HTTP — a reply of ANY status means a process answered the socket.
  if (target.hostPort > 0) {
    try {
      const http = await probeOnce(target.hostPort, '/', PROBE_TIMEOUT_MS);
      if (http.replied) {
        outcome.httpStatus = http.status;
        if (http.status >= 500) outcome.detail = `HTTP ${http.status}`;
        return outcome;
      }
    } catch {
      /* fall through to the TCP/container channels */
    }
    // 2. TCP fallback.
    try {
      outcome.portListening = await driver.isPortListening(target.hostPort);
    } catch {
      /* leave undefined */
    }
  }

  // 3. Container liveness + post-mortem detail.
  if (target.containerId) {
    try {
      const inspect = await driver.inspectContainer(target.containerId);
      outcome.containerRunning = inspect.exists && inspect.running;
      if (!outcome.containerRunning) {
        outcome.detail = await describeDeadContainer(driver, target.containerId, inspect.exists);
      }
    } catch {
      /* leave undefined — evaluateProbe will hold the previous state */
    }
  }
  if (outcome.detail === undefined && outcome.portListening === false) {
    outcome.detail = `port ${target.hostPort} not listening`;
  }
  return outcome;
}

async function describeDeadContainer(
  driver: ProbeDriverLike,
  containerId: string,
  exists: boolean,
): Promise<string> {
  if (!exists) return 'container gone';
  try {
    const state = await driver.getContainerState(containerId);
    if (!state) return 'container not running';
    const parts = [`exit=${state.exitCode ?? 'null'}`];
    if (state.oomKilled) parts.push('oom-killed');
    if (state.error) parts.push(String(state.error));
    return `container not running (${parts.join(' ')})`;
  } catch {
    return 'container not running';
  }
}
