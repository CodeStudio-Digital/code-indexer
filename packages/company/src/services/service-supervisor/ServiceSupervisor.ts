/**
 * ServiceSupervisor — periodic health watchdog over a session's sandbox
 * containers (primary as 'main' + every secondary service), company B3.
 *
 * Per tick (15s default, `MCP_SERVICE_HEALTH_MS`, floor 5s): probe (HTTP →
 * TCP → container) → health-core verdict → persist health → transition +
 * `sandbox.service.health` WHEN CHANGED → heartbeat every 4 ticks →
 * decideAction: 'restart' (auto-restart ON, session not frozen) via the
 * manager + bumpRestartCount + `sandbox.service.restarted`; 'incident' →
 * incidents.ts fan-out, deduped per down-episode. B4: the same tick then
 * runs the ServiceLogCollector (incremental log tail → logs store +
 * `sandbox.service.log_batch`); `MCP_SERVICE_LOGS='0'` disables it.
 * B8: the tick also probes the session's HOST process (discovered via the
 * `company_local_projects` row — see `health-target.ts`) under serviceId
 * `local:<sessionId>`: health in memory + events only, incident on down,
 * never auto-restart.
 *
 * RUNS ONLY IN THE COMPANY WORKER — constructed by wire-services.ts,
 * started by MasterLifecycle start/resume. Never start this loop from
 * main-process routes: the store bindings (`stores.ts`) are worker-only.
 * Timer is `.unref()`ed with an anti-overlap guard (RuntimeReconciler
 * pattern) so a slow driver never stacks ticks or holds Node alive.
 */
import { getSandboxManager, resolveDriver } from '@mcp/services/sandbox/index.js';
import { resolveAutonomy } from '@mcp/company/services/autonomy/autonomy-config.js';
import type { AutonomyProvider } from '@mcp/company/services/autonomy/autonomy-provider.js';
import {
  decideAction,
  evaluateProbe,
  pruneAttempts,
  resolveRestartPolicy,
  type HealthState,
  type RestartAttempt,
} from './health-core.js';
import { probeService, type ProbeDriverLike } from './probes.js';
import {
  localServiceId,
  probeHealthTarget,
  type LocalHealthTarget,
  type LocalProbeIo,
} from './health-target.js';
import { emitIncident, type IncidentDeps } from './incidents.js';
import { getServiceSupervisorStores, type ServiceSupervisorStores } from './stores.js';
import {
  ServiceLogCollector,
  type CollectedLogLine,
  type LogCollectorDriver,
  type LogTarget,
} from '@mcp/services/sandbox/manager/log-collector.js';

const DEFAULT_TICK_MS = 15_000;
const MIN_TICK_MS = 5_000;
const HEARTBEAT_EVERY_TICKS = 4;
/** Max lines per `sandbox.service.log_batch` event — the excess only persists. */
const LOG_BATCH_PUBLISH_MAX = 50;

function readTickMs(env: NodeJS.ProcessEnv): number {
  const raw = env.MCP_SERVICE_HEALTH_MS;
  if (!raw) return DEFAULT_TICK_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.max(n, MIN_TICK_MS) : DEFAULT_TICK_MS;
}

/** Structural slices of Sandbox/SandboxManager — fakes stay tiny in tests. */
export interface SupervisedSandboxLike {
  status: string;
  runtimePaused?: boolean;
  attached?: boolean;
  hostPort: number;
  containerId: string;
  /** 'default' | 'project_dockerfile' — routes log collection (B4). */
  imageSource?: string;
}
export interface SupervisorManagerLike {
  get(sessionId: string): SupervisedSandboxLike | undefined;
  listServicesWithIds(
    sessionId: string,
  ): Array<{ serviceId: string; sandbox: SupervisedSandboxLike }>;
  restartDevServer(sessionId: string): Promise<void>;
  restartService(sessionId: string, serviceId: string): Promise<void>;
}

export interface ServiceSupervisorDeps {
  sessionId: number;
  publisher: { publish(event: string, data: unknown): void };
  incidents: IncidentDeps;
  /** Per-session autonomy — `freeze: true` disables auto-restart LIVE. */
  autonomy?: Pick<AutonomyProvider, 'get'>;
  /** Overrides for tests. Default to the process-wide singletons. */
  manager?: SupervisorManagerLike;
  resolveDriver?: () => Promise<ProbeDriverLike>;
  stores?: ServiceSupervisorStores | null;
  /** B8 — injectable IO for the host-process probe (tests use fakes). */
  localProbeIo?: LocalProbeIo;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
}

/** Statuses worth probing — everything else is deliberately not serving. */
const PROBEABLE_STATUSES = new Set(['ready', 'error']);
/** B8 — host-process row statuses worth probing. `error` stays probeable
 *  so a crash (LPM flips the row to 'error' on exit) still raises the
 *  down → incident path; `destroyed`/`destroying` are user-initiated. */
const LOCAL_PROBEABLE_STATUSES = new Set(['running', 'error']);

export class ServiceSupervisor {
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;
  private tickCount = 0;
  private readonly lastHealth = new Map<string, HealthState>();
  private readonly attempts = new Map<string, RestartAttempt[]>();
  /** serviceIds with an un-recovered incident (dedupe per down-episode). */
  private readonly incidentOpen = new Set<string>();
  /** B4 — per-service byte-offset/timestamp cursors for incremental log tails. */
  private readonly logCollector = new ServiceLogCollector();

  constructor(private readonly deps: ServiceSupervisorDeps) {}

  private get env(): NodeJS.ProcessEnv { return this.deps.env ?? process.env; }
  private nowMs(): number { return this.deps.now ? this.deps.now() : Date.now(); }
  private get sessionKey(): string { return String(this.deps.sessionId); }
  private get manager(): SupervisorManagerLike {
    return this.deps.manager ?? (getSandboxManager() as unknown as SupervisorManagerLike);
  }
  private stores(): ServiceSupervisorStores | null {
    return this.deps.stores !== undefined ? this.deps.stores : getServiceSupervisorStores();
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.ticking) return; // anti-overlap (RuntimeReconciler pattern)
      void this.tick();
    }, readTickMs(this.env));
    if (typeof (this.timer as { unref?: () => void }).unref === 'function') {
      (this.timer as { unref: () => void }).unref();
    }
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Exposed for tests — one full pass, guarded against overlap. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      this.tickCount++;
      const entries = this.collectEntries();
      const localTargets = this.collectLocalTargets();
      if (entries.length === 0 && localTargets.length === 0) return;
      // B8 — the driver is container-only; resolve it lazily and tolerate
      // failure so a missing container runtime never blocks host-process
      // supervision (and vice versa).
      let driver: ProbeDriverLike | null = null;
      if (entries.length > 0) {
        try {
          driver = await (this.deps.resolveDriver ?? resolveDriver)();
        } catch (e) {
          console.warn(
            `[service-supervisor s=${this.deps.sessionId}] driver resolution failed: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }
      const beat: Array<{ serviceId: string; health: HealthState }> = [];
      if (driver) {
        for (const { serviceId, sandbox } of entries) {
          try {
            const health = await this.superviseOne(driver, serviceId, sandbox);
            if (health) beat.push({ serviceId, health });
          } catch (e) {
            console.warn(
              `[service-supervisor s=${this.deps.sessionId}] ${serviceId} pass failed: ${e instanceof Error ? e.message : String(e)}`,
            );
          }
        }
      }
      for (const target of localTargets) {
        try {
          const health = await this.superviseLocal(target);
          if (health) beat.push({ serviceId: target.serviceId, health });
        } catch (e) {
          console.warn(
            `[service-supervisor s=${this.deps.sessionId}] ${target.serviceId} pass failed: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }
      if (beat.length > 0 && this.tickCount % HEARTBEAT_EVERY_TICKS === 0) {
        this.deps.publisher.publish('sandbox.service.heartbeat', {
          sandboxId: this.sessionKey,
          services: beat,
          at: this.nowMs(),
        });
      }
      // B4 — structured log collection rides THIS tick (decision: one
      // exec pair per service per 15s beats a dedicated 3s poller on
      // cost; MCP_SERVICE_LOGS='0' opts out). Container-only: host
      // processes stream their output through the LPM event path.
      if (driver) await this.collectServiceLogs(driver, entries);
    } finally {
      this.ticking = false;
    }
  }

  /** B4 — incremental per-service log tail → logs store + `log_batch` event. */
  private async collectServiceLogs(
    driver: ProbeDriverLike,
    entries: Array<{ serviceId: string; sandbox: SupervisedSandboxLike }>,
  ): Promise<void> {
    if (this.env.MCP_SERVICE_LOGS === '0') return;
    const d = driver as Partial<LogCollectorDriver>;
    if (typeof d.exec !== 'function' || typeof d.getContainerLogs !== 'function') return;
    const targets: LogTarget[] = entries.map(({ serviceId, sandbox }) => ({
      serviceId,
      containerId: sandbox.containerId,
      channel:
        sandbox.attached || sandbox.imageSource === 'project_dockerfile'
          ? 'container'
          : 'devserver',
    }));
    this.logCollector.prune(new Set(targets.map((t) => t.serviceId)));
    let rows: CollectedLogLine[];
    try {
      rows = await this.logCollector.collect(d as LogCollectorDriver, targets, this.nowMs());
    } catch {
      return; // collector is best-effort by contract; belt and braces here
    }
    if (rows.length === 0) return;
    try {
      this.stores()?.logs?.appendAndTrim(
        rows.map((r) => ({
          sessionId: this.deps.sessionId,
          serviceId: r.serviceId,
          stream: r.stream,
          line: r.line,
          atMs: r.atMs,
        })),
      );
    } catch { /* ring buffer is advisory — never break the tick */ }
    const byService = new Map<string, CollectedLogLine[]>();
    for (const r of rows) {
      const list = byService.get(r.serviceId) ?? [];
      list.push(r);
      byService.set(r.serviceId, list);
    }
    for (const [serviceId, lines] of byService) {
      this.deps.publisher.publish('sandbox.service.log_batch', {
        sandboxId: this.sessionKey,
        serviceId,
        lines: lines
          .slice(-LOG_BATCH_PUBLISH_MAX)
          .map((l) => ({ atMs: l.atMs, stream: l.stream, line: l.line })),
        at: this.nowMs(),
      });
    }
  }

  private collectEntries(): Array<{ serviceId: string; sandbox: SupervisedSandboxLike }> {
    const out: Array<{ serviceId: string; sandbox: SupervisedSandboxLike }> = [];
    const primary = this.manager.get(this.sessionKey);
    if (primary) out.push({ serviceId: 'main', sandbox: primary });
    out.push(...this.manager.listServicesWithIds(this.sessionKey));
    return out.filter(
      ({ sandbox }) =>
        !sandbox.runtimePaused && !!sandbox.containerId && PROBEABLE_STATUSES.has(sandbox.status),
    );
  }

  /**
   * B8 — the session's host process (`company_local_projects` row) as a
   * probe target. Worker-safe by construction: reads the SQLite row via
   * the stores binding, never the LocalProcessManager singleton (which
   * lives on the main process). No row / destroyed row → no target.
   */
  private collectLocalTargets(): LocalHealthTarget[] {
    let row: { pid: number | null; host_port: number; status: string } | null = null;
    try {
      row = this.stores()?.localProjects?.listBySession(this.deps.sessionId) ?? null;
    } catch {
      return []; // discovery is advisory — never break the tick
    }
    if (!row || !LOCAL_PROBEABLE_STATUSES.has(row.status)) return [];
    return [
      {
        kind: 'local',
        serviceId: localServiceId(this.deps.sessionId),
        hostPort: row.host_port,
        pid: row.pid,
      },
    ];
  }

  /**
   * B8 — health-only supervision of the session's host process. Three
   * deliberate differences from `superviseOne`:
   *   - NO store writes: there is no `company_sandbox_services` row for
   *     host processes (and no new migration) — health lives in the
   *     `lastHealth` map here + on the `sandbox.service.health` events.
   *   - NO auto-restart (v1): the supervisor can't respawn a process it
   *     didn't spawn (the LPM owns the child on the main process).
   *   - `down` escalates STRAIGHT to `emitIncident` (restartAttempts 0),
   *     deduped per down-episode via `incidentOpen`, same as containers.
   */
  private async superviseLocal(target: LocalHealthTarget): Promise<HealthState | null> {
    const now = this.nowMs();
    const outcome = await probeHealthTarget(target, { local: this.deps.localProbeIo });
    const prev = this.lastHealth.get(target.serviceId) ?? 'unknown';
    const verdict = evaluateProbe(outcome, prev);
    this.lastHealth.set(target.serviceId, verdict.next);
    if (verdict.changed) {
      this.deps.publisher.publish('sandbox.service.health', {
        sandboxId: this.sessionKey, serviceId: target.serviceId,
        health: verdict.next, detail: verdict.detail ?? null, at: now,
      });
    }
    if (verdict.next === 'healthy') this.incidentOpen.delete(target.serviceId);
    if (verdict.next === 'down' && !this.incidentOpen.has(target.serviceId)) {
      this.incidentOpen.add(target.serviceId);
      await emitIncident(this.deps.incidents, {
        sessionId: this.deps.sessionId, serviceId: target.serviceId,
        detail: verdict.detail, restartAttempts: 0, atMs: now,
      });
    }
    return verdict.next;
  }

  /** Probe + verdict + persistence + action for one service. */
  private async superviseOne(
    driver: ProbeDriverLike,
    serviceId: string,
    sandbox: SupervisedSandboxLike,
  ): Promise<HealthState | null> {
    const now = this.nowMs();
    const outcome = await probeService(driver, {
      hostPort: sandbox.hostPort,
      containerId: sandbox.containerId || null,
    });
    const prev = this.lastHealth.get(serviceId) ?? 'unknown';
    const verdict = evaluateProbe(outcome, prev);
    this.lastHealth.set(serviceId, verdict.next);
    const stores = this.stores();
    try {
      stores?.health.updateHealth(this.deps.sessionId, serviceId, {
        health: verdict.next,
        healthDetail: verdict.detail ?? null,
        lastHealthAtMs: now,
      });
    } catch { /* health column is advisory — never break the tick */ }
    if (verdict.changed) {
      try {
        stores?.transitions.record({
          sessionId: this.deps.sessionId, serviceId, kind: 'health',
          fromState: prev, toState: verdict.next,
          reason: verdict.detail ?? null, actor: 'supervisor', atMs: now,
        });
      } catch { /* best-effort */ }
      this.deps.publisher.publish('sandbox.service.health', {
        sandboxId: this.sessionKey, serviceId,
        health: verdict.next, detail: verdict.detail ?? null, at: now,
      });
    }
    if (verdict.next === 'healthy') this.incidentOpen.delete(serviceId);
    await this.act(serviceId, sandbox, verdict.next, verdict.detail, now);
    return verdict.next;
  }

  private async act(
    serviceId: string,
    sandbox: SupervisedSandboxLike,
    health: HealthState,
    detail: string | undefined,
    now: number,
  ): Promise<void> {
    if (sandbox.attached) return; // lifecycle belongs to the host
    const policy = resolveRestartPolicy(this.env);
    const attempts = pruneAttempts(this.attempts.get(serviceId) ?? [], now, policy.windowMs);
    this.attempts.set(serviceId, attempts);
    const action = decideAction(health, attempts, now, policy);
    if (action === 'restart') {
      if (!policy.enabled || this.isFrozen()) return;
      await this.restartOne(serviceId, detail, attempts, now);
    } else if (action === 'incident' && !this.incidentOpen.has(serviceId)) {
      this.incidentOpen.add(serviceId);
      await emitIncident(this.deps.incidents, {
        sessionId: this.deps.sessionId, serviceId,
        detail, restartAttempts: attempts.length, atMs: now,
      });
    }
  }

  private async restartOne(
    serviceId: string,
    detail: string | undefined,
    attempts: RestartAttempt[],
    now: number,
  ): Promise<void> {
    attempts.push({ atMs: now });
    const stores = this.stores();
    try {
      if (serviceId === 'main') await this.manager.restartDevServer(this.sessionKey);
      else await this.manager.restartService(this.sessionKey, serviceId);
      try {
        stores?.health.bumpRestartCount(this.deps.sessionId, serviceId);
        stores?.transitions.record({
          sessionId: this.deps.sessionId, serviceId, kind: 'status',
          toState: 'restarted', reason: `auto-restart (${detail ?? 'health=down'})`,
          actor: 'supervisor', atMs: now,
        });
      } catch { /* best-effort */ }
      this.deps.publisher.publish('sandbox.service.restarted', {
        sandboxId: this.sessionKey, serviceId, reason: 'auto-restart', at: now,
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      try {
        stores?.transitions.record({
          sessionId: this.deps.sessionId, serviceId, kind: 'status',
          toState: 'restart_failed', reason: message, actor: 'supervisor', atMs: now,
        });
      } catch { /* best-effort */ }
      console.warn(
        `[service-supervisor s=${this.deps.sessionId}] auto-restart of ${serviceId} failed: ${message}`,
      );
    }
  }

  private isFrozen(): boolean {
    const cfg = this.deps.autonomy ? this.deps.autonomy.get() : resolveAutonomy(null, this.env);
    return cfg.freeze;
  }
}
