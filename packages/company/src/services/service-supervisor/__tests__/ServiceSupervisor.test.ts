/**
 * ServiceSupervisor loop tests — manager/driver/store fakes, injected
 * clock/env, `tick()` driven directly (no timers). The probe's container
 * channel is exercised with `hostPort: 0` (skips real HTTP/TCP); the
 * healthy path spins a real ephemeral HTTP server on 127.0.0.1.
 */
import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ServiceSupervisor, type ServiceSupervisorDeps, type SupervisedSandboxLike } from '../ServiceSupervisor.js';
import type { ProbeDriverLike } from '../probes.js';
import type { LocalProbeIo } from '../health-target.js';

const SESSION_ID = '00000000-0000-4000-8000-000000000012';
const TRANSITION_ID = '00000000-0000-4000-8000-000000000101';
const LOCAL_SERVICE_ID = `local:${SESSION_ID}`;

function deadDriver(): ProbeDriverLike {
  return {
    isPortListening: async () => false,
    inspectContainer: async () => ({ exists: true, running: false }),
    getContainerState: async () => ({ exitCode: 137, oomKilled: false }),
  };
}

function sandbox(over: Partial<SupervisedSandboxLike> = {}): SupervisedSandboxLike {
  return { status: 'ready', hostPort: 0, containerId: 'c-1', ...over };
}

function makeSupervisor(opts: {
  primary?: SupervisedSandboxLike | undefined;
  services?: Array<{ serviceId: string; sandbox: SupervisedSandboxLike }>;
  driver?: ProbeDriverLike;
  env?: Record<string, string>;
  now?: () => number;
  autonomyFreeze?: boolean;
  /** B8 — session host-process row (company_local_projects fake). */
  localRow?: { pid: number | null; host_port: number; status: string } | null;
  localProbeIo?: LocalProbeIo;
  /** B8 — simulate a missing container runtime. */
  driverResolutionFails?: boolean;
}) {
  const published: Array<{ event: string; data: unknown }> = [];
  const calls = {
    restartService: vi.fn(async () => {}),
    restartDevServer: vi.fn(async () => {}),
    updateHealth: vi.fn(() => true),
    bumpRestartCount: vi.fn(() => 1),
    record: vi.fn((_input?: unknown) => TRANSITION_ID),
    notify: vi.fn(),
    boardPost: vi.fn(),
  };
  const deps: ServiceSupervisorDeps = {
    sessionId: SESSION_ID,
    publisher: { publish: (event, data) => published.push({ event, data }) },
    incidents: {
      notifyMaster: calls.notify,
      board: { post: calls.boardPost },
      publisher: { publish: (event, data) => published.push({ event, data }) },
    },
    autonomy: opts.autonomyFreeze === undefined
      ? undefined
      : { get: () => ({ freeze: opts.autonomyFreeze }) as never },
    manager: {
      get: () => opts.primary,
      listServicesWithIds: () => opts.services ?? [],
      restartDevServer: calls.restartDevServer,
      restartService: calls.restartService,
    },
    resolveDriver: async () => {
      if (opts.driverResolutionFails) throw new Error('no container runtime');
      return opts.driver ?? deadDriver();
    },
    stores: {
      health: { updateHealth: calls.updateHealth, bumpRestartCount: calls.bumpRestartCount },
      transitions: { record: calls.record },
      localProjects: { listBySession: () => opts.localRow ?? null },
    },
    localProbeIo: opts.localProbeIo,
    env: (opts.env ?? {}) as NodeJS.ProcessEnv,
    now: opts.now,
  };
  return { supervisor: new ServiceSupervisor(deps), published, calls };
}

let server: Server | null = null;
afterEach(() => {
  server?.close();
  server = null;
});

function listen(statusCode: number): Promise<number> {
  return new Promise((resolve) => {
    server = createServer((_req, res) => {
      res.statusCode = statusCode;
      res.end('ok');
    });
    server.listen(0, '127.0.0.1', () => {
      resolve((server!.address() as { port: number }).port);
    });
  });
}

describe('ServiceSupervisor.tick', () => {
  it('persists a health change, records a transition and publishes once', async () => {
    const { supervisor, published, calls } = makeSupervisor({
      services: [{ serviceId: 'api', sandbox: sandbox() }],
    });
    await supervisor.tick();
    expect(calls.updateHealth).toHaveBeenCalledWith(
      SESSION_ID,
      'api',
      expect.objectContaining({ health: 'down' }),
    );
    expect(calls.record).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'health', fromState: 'unknown', toState: 'down', actor: 'supervisor' }),
    );
    const healthEvents = published.filter((p) => p.event === 'sandbox.service.health');
    expect(healthEvents).toHaveLength(1);
    expect(healthEvents[0]!.data).toMatchObject({ serviceId: 'api', health: 'down' });

    // Unchanged on the next tick → no second health transition/publish.
    calls.record.mockClear();
    await supervisor.tick();
    const healthRecords = calls.record.mock.calls.filter(
      (c) => (c[0] as { kind?: string } | undefined)?.kind === 'health',
    );
    expect(healthRecords).toHaveLength(0);
    expect(published.filter((p) => p.event === 'sandbox.service.health')).toHaveLength(1);
  });

  it('reports healthy for an HTTP 200 service (real ephemeral server)', async () => {
    const port = await listen(200);
    const { supervisor, calls } = makeSupervisor({
      services: [{ serviceId: 'web', sandbox: sandbox({ hostPort: port }) }],
    });
    await supervisor.tick();
    expect(calls.updateHealth).toHaveBeenCalledWith(
      SESSION_ID,
      'web',
      expect.objectContaining({ health: 'healthy' }),
    );
    expect(calls.restartService).not.toHaveBeenCalled();
  });

  it('HTTP 5xx is degraded and does NOT auto-restart', async () => {
    const port = await listen(503);
    const { supervisor, calls } = makeSupervisor({
      services: [{ serviceId: 'web', sandbox: sandbox({ hostPort: port }) }],
    });
    await supervisor.tick();
    expect(calls.updateHealth).toHaveBeenCalledWith(
      SESSION_ID,
      'web',
      expect.objectContaining({ health: 'degraded' }),
    );
    expect(calls.restartService).not.toHaveBeenCalled();
  });

  it('restarts a down service (manager.restartService) and bumps the counter', async () => {
    const { supervisor, published, calls } = makeSupervisor({
      services: [{ serviceId: 'api', sandbox: sandbox() }],
    });
    await supervisor.tick();
    expect(calls.restartService).toHaveBeenCalledWith(SESSION_ID, 'api');
    expect(calls.bumpRestartCount).toHaveBeenCalledWith(SESSION_ID, 'api');
    expect(calls.record).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'status', toState: 'restarted', actor: 'supervisor' }),
    );
    expect(published.some((p) => p.event === 'sandbox.service.restarted')).toBe(true);
  });

  it('routes the primary through restartDevServer under serviceId main', async () => {
    const { supervisor, calls } = makeSupervisor({ primary: sandbox() });
    await supervisor.tick();
    expect(calls.restartDevServer).toHaveBeenCalledWith(SESSION_ID);
    expect(calls.restartService).not.toHaveBeenCalled();
  });

  it('frozen session: health is persisted but nothing restarts', async () => {
    const { supervisor, calls } = makeSupervisor({
      services: [{ serviceId: 'api', sandbox: sandbox() }],
      autonomyFreeze: true,
    });
    await supervisor.tick();
    expect(calls.updateHealth).toHaveBeenCalled();
    expect(calls.restartService).not.toHaveBeenCalled();
    expect(calls.restartDevServer).not.toHaveBeenCalled();
  });

  it('MCP_SERVICE_AUTO_RESTART=0 disables restarts', async () => {
    const { supervisor, calls } = makeSupervisor({
      services: [{ serviceId: 'api', sandbox: sandbox() }],
      env: { MCP_SERVICE_AUTO_RESTART: '0' },
    });
    await supervisor.tick();
    expect(calls.restartService).not.toHaveBeenCalled();
  });

  it('skips paused / attached-lifecycle-exempt / non-probeable services', async () => {
    const { supervisor, calls } = makeSupervisor({
      services: [
        { serviceId: 'paused', sandbox: sandbox({ status: 'paused' }) },
        { serviceId: 'rpaused', sandbox: sandbox({ runtimePaused: true }) },
        { serviceId: 'provisioning', sandbox: sandbox({ status: 'provisioning' }) },
        { serviceId: 'attached', sandbox: sandbox({ attached: true }) },
      ],
    });
    await supervisor.tick();
    // Only the attached one is probeable; it gets health but never a restart.
    expect(calls.updateHealth).toHaveBeenCalledTimes(1);
    expect(calls.updateHealth).toHaveBeenCalledWith(
      SESSION_ID,
      'attached',
      expect.anything(),
    );
    expect(calls.restartService).not.toHaveBeenCalled();
  });

  it('escalates to a single incident after the attempt window is exhausted', async () => {
    let now = 0;
    const { supervisor, published, calls } = makeSupervisor({
      services: [{ serviceId: 'api', sandbox: sandbox() }],
      now: () => now,
    });
    await supervisor.tick();          // t=0     → restart #1
    now = 6_000; await supervisor.tick();   // ≥5s     → restart #2
    now = 25_000; await supervisor.tick();  // ≥15s    → restart #3
    expect(calls.restartService).toHaveBeenCalledTimes(3);
    now = 80_000; await supervisor.tick();  // window full → incident
    expect(calls.restartService).toHaveBeenCalledTimes(3);
    expect(calls.notify).toHaveBeenCalledTimes(1);
    expect(published.some((p) => p.event === 'sandbox.service.incident')).toBe(true);
    // Dedupe: still down on the next tick → no second incident.
    now = 95_000; await supervisor.tick();
    expect(calls.notify).toHaveBeenCalledTimes(1);
  });

  // ─── B8: host-process targets (`local:<sessionId>`) ─────────────

  it('local target down: memory-only health, one event, one incident, NO restart', async () => {
    const { supervisor, published, calls } = makeSupervisor({
      localRow: { pid: 4242, host_port: 0, status: 'running' },
      localProbeIo: { isPidAlive: () => false },
    });
    await supervisor.tick();
    const healthEvents = published.filter((p) => p.event === 'sandbox.service.health');
    expect(healthEvents).toHaveLength(1);
    expect(healthEvents[0]!.data).toMatchObject({
      serviceId: LOCAL_SERVICE_ID,
      health: 'down',
      detail: 'process 4242 not running',
    });
    // Memory-only: nothing persisted, nothing restarted.
    expect(calls.updateHealth).not.toHaveBeenCalled();
    expect(calls.record).not.toHaveBeenCalled();
    expect(calls.restartService).not.toHaveBeenCalled();
    expect(calls.restartDevServer).not.toHaveBeenCalled();
    // Incident fires immediately (no restart ladder for host processes)…
    expect(calls.notify).toHaveBeenCalledTimes(1);
    expect(calls.notify).toHaveBeenCalledWith(expect.stringContaining('[SERVICE INCIDENT]'));
    expect(
      published.some(
        (p) =>
          p.event === 'sandbox.service.incident' &&
          (p.data as { serviceId?: string }).serviceId === LOCAL_SERVICE_ID,
      ),
    ).toBe(true);
    // …and dedupes per down-episode.
    await supervisor.tick();
    expect(calls.notify).toHaveBeenCalledTimes(1);
  });

  it('local target healthy via HTTP: event only, no incident', async () => {
    const { supervisor, published, calls } = makeSupervisor({
      localRow: { pid: 4242, host_port: 3000, status: 'running' },
      localProbeIo: { probeHttp: async () => ({ replied: true, status: 200 }) },
    });
    await supervisor.tick();
    const healthEvents = published.filter((p) => p.event === 'sandbox.service.health');
    expect(healthEvents).toHaveLength(1);
    expect(healthEvents[0]!.data).toMatchObject({
      serviceId: LOCAL_SERVICE_ID,
      health: 'healthy',
    });
    expect(calls.notify).not.toHaveBeenCalled();
    expect(calls.updateHealth).not.toHaveBeenCalled();
  });

  it('driver resolution failure never blocks host-process supervision', async () => {
    const { supervisor, published, calls } = makeSupervisor({
      services: [{ serviceId: 'api', sandbox: sandbox() }],
      driverResolutionFails: true,
      localRow: { pid: 4242, host_port: 3000, status: 'running' },
      localProbeIo: {
        probeHttp: async () => ({ replied: false, status: 0 }),
        isPortListening: async () => true,
        isPidAlive: () => true,
      },
    });
    await supervisor.tick();
    // Container pass skipped (no driver) — no health write, no restart.
    expect(calls.updateHealth).not.toHaveBeenCalled();
    expect(calls.restartService).not.toHaveBeenCalled();
    // Local pass still ran: port open but HTTP mute ⇒ degraded event.
    const healthEvents = published.filter((p) => p.event === 'sandbox.service.health');
    expect(healthEvents).toHaveLength(1);
    expect(healthEvents[0]!.data).toMatchObject({
      serviceId: LOCAL_SERVICE_ID,
      health: 'degraded',
    });
  });

  it('destroyed/absent local rows produce no local target', async () => {
    const { supervisor, published } = makeSupervisor({
      localRow: { pid: 4242, host_port: 0, status: 'destroying' },
      localProbeIo: { isPidAlive: () => false },
    });
    await supervisor.tick();
    expect(published.filter((p) => p.event === 'sandbox.service.health')).toHaveLength(0);
  });

  it('anti-overlap: a tick that is still running blocks a second entry', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const managerGet = vi.fn(() => sandbox());
    const { supervisor } = makeSupervisor({ primary: sandbox() });
    // Swap in a driver that hangs until released.
    const deps = (supervisor as unknown as { deps: ServiceSupervisorDeps }).deps;
    deps.manager!.get = managerGet;
    deps.resolveDriver = async () => { await gate; return deadDriver(); };
    const first = supervisor.tick();
    const second = supervisor.tick(); // must bail on the guard
    await second;
    expect(managerGet).toHaveBeenCalledTimes(1);
    release();
    await first;
  });
});
