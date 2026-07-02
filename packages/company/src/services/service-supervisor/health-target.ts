/**
 * HealthTarget (company B8) — one vocabulary for everything the
 * ServiceSupervisor probes. Containers keep the driver-backed probe in
 * `probes.ts`; LOCAL host processes (LocalProcessManager projects) get a
 * driver-less probe with the same channel order, cheapest first:
 *
 *   1. HTTP GET on the registered port (`probeOnce` — the same helper the
 *      container path uses, 2s budget).
 *   2. Bare TCP connect on 127.0.0.1 (`node:net` — the LPM always binds
 *      HOST=127.0.0.1, and no driver exists for host processes).
 *   3. `process.kill(pid, 0)` liveness — ESRCH ⇒ dead, EPERM ⇒ alive but
 *      owned by someone else (still alive). Works on Windows + POSIX.
 *
 * The outcome deliberately reuses `ProbeOutcome.containerRunning` for
 * "process running": health-core's `classify()` treats that field as
 * generic unit liveness, so healthy/degraded/down semantics stay
 * identical without forking health-core.
 *
 * WHY the supervisor never touches the LocalProcessManager singleton:
 * the LPM lives on the MAIN process (spawned by the HTTP routes /
 * electron) and module globals don't cross worker_threads — the
 * supervisor (company worker) reads the `company_local_projects` SQLite
 * row instead (pid + host_port + status are host-level facts). Local
 * health is NOT persisted anywhere (no `company_sandbox_services` row,
 * no new migration): it lives in supervisor memory and rides the
 * `sandbox.service.health` events under the `local:<sessionId>` id.
 */
import { connect } from 'node:net';
import { probeOnce } from '@mcp/services/sandbox/local-process/readiness-probe.js';
import type { ProbeOutcome } from './health-core.js';
import { probeService, PROBE_TIMEOUT_MS, type ProbeDriverLike } from './probes.js';

export type HealthTarget =
  | { kind: 'container'; serviceId: string; hostPort: number; containerId: string | null }
  | { kind: 'local'; serviceId: string; hostPort: number; pid: number | null };

export type LocalHealthTarget = Extract<HealthTarget, { kind: 'local' }>;

/** serviceId under which a session's host process reports health (B8). */
export function localServiceId(sessionId: number): string {
  return `local:${sessionId}`;
}

/** Injectable IO for the local probe — tests hand in fakes. */
export interface LocalProbeIo {
  probeHttp?: (
    port: number,
    path: string,
    timeoutMs: number,
  ) => Promise<{ replied: boolean; status: number }>;
  isPortListening?: (port: number) => Promise<boolean>;
  isPidAlive?: (pid: number) => boolean;
}

/**
 * Probe one host process. Same never-throw posture as `probeService`:
 * an unknowable channel stays `undefined` so `evaluateProbe` holds the
 * previous state instead of flapping.
 */
export async function probeLocalProcess(
  target: { hostPort: number; pid: number | null },
  io: LocalProbeIo = {},
): Promise<ProbeOutcome> {
  const outcome: ProbeOutcome = {};
  const http = io.probeHttp ?? probeOnce;
  const listening = io.isPortListening ?? isLoopbackPortListening;
  const alive = io.isPidAlive ?? isPidAlive;

  // 1. HTTP — a reply of ANY status means a process answered the socket.
  if (target.hostPort > 0) {
    try {
      const reply = await http(target.hostPort, '/', PROBE_TIMEOUT_MS);
      if (reply.replied) {
        outcome.httpStatus = reply.status;
        if (reply.status >= 500) outcome.detail = `HTTP ${reply.status}`;
        return outcome;
      }
    } catch {
      /* fall through to the TCP/pid channels */
    }
    // 2. TCP fallback.
    try {
      outcome.portListening = await listening(target.hostPort);
    } catch {
      /* leave undefined */
    }
  }

  // 3. Process liveness (`containerRunning` = generic unit liveness).
  if (target.pid != null && target.pid > 0) {
    try {
      outcome.containerRunning = alive(target.pid);
      if (!outcome.containerRunning) outcome.detail = `process ${target.pid} not running`;
    } catch {
      /* leave undefined — evaluateProbe holds the previous state */
    }
  }
  if (outcome.detail === undefined && outcome.portListening === false) {
    outcome.detail = `port ${target.hostPort} not listening`;
  }
  return outcome;
}

/**
 * Unified dispatch — container targets need the driver; local ones don't.
 * A container probe without a driver returns `{}` ("learned nothing"),
 * which keeps the previous health instead of inventing a verdict.
 */
export async function probeHealthTarget(
  target: HealthTarget,
  io: { driver?: ProbeDriverLike | null; local?: LocalProbeIo } = {},
): Promise<ProbeOutcome> {
  if (target.kind === 'container') {
    if (!io.driver) return {};
    return probeService(io.driver, {
      hostPort: target.hostPort,
      containerId: target.containerId,
    });
  }
  return probeLocalProcess(target, io.local);
}

/** `kill(pid, 0)` — signal 0 only checks existence. EPERM ⇒ alive. */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Driver-less TCP check on 127.0.0.1 (the LPM binds HOST=127.0.0.1). */
export function isLoopbackPortListening(
  port: number,
  timeoutMs: number = PROBE_TIMEOUT_MS,
): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ port, host: '127.0.0.1' });
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}
