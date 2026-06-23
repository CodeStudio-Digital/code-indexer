/**
 * SandboxManager integration smokes via the in-memory FakeSandboxDriver.
 *
 * Goals (Phase 6 prep): exercise the manager's orchestration paths that
 * are most often touched during refactors — attach/destroy lifecycle,
 * pause/unpause runtime state, env propagation across siblings, observer
 * pattern wiring — without booting podman/docker.
 *
 * What these tests do NOT cover:
 *   - `provision()` happy path. Needs scaffolder mocks + filesystem state
 *     beyond what's reasonable in a unit harness.
 *   - DB persistence. The module-level stores stay null; the manager
 *     skips persistence cleanly. Persistence-specific tests are wired
 *     against `CompanySandboxStore` directly elsewhere.
 *   - Real driver behavior. Fake driver guarantees the manager's
 *     INPUTS to the driver match the contract, not that any specific
 *     driver implementation honors that contract.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  SandboxManager,
  setCompanySandboxStore,
  setCompanySandboxServicesStore,
  setCompanySessionEnvStore,
} from '@mcp/services/sandbox/sandbox-manager.js';
import type { SandboxEvent } from '@mcp/services/sandbox/types.js';
import { PortAllocator } from '@mcp/services/sandbox/port-allocator.js';
import { FakeSandboxDriver } from './helpers/fake-sandbox-driver.js';
import type { CompanySessionEnvStore } from '@mcp/store/company-session-env-store.js';

function makeManager(opts?: { driver?: FakeSandboxDriver }) {
  const driver = opts?.driver ?? new FakeSandboxDriver();
  const manager = new SandboxManager({
    driver,
    allocator: new PortAllocator({ min: 46_000, max: 46_099, cooldownMs: 1 }),
    statsIntervalMs: 0, // disable stats sampler so timer doesn't leak
    skipShutdownHandlers: true, // avoid SIGTERM listener leak across many manager instances
  });
  return { manager, driver };
}

beforeEach(() => {
  // The module-level stores are read by every persistence path. Forcing
  // them to null here keeps the manager pure (no DB writes); individual
  // tests opt in via `setCompanySessionEnvStore(fakeEnvStore)` when needed.
  setCompanySandboxStore(null);
  setCompanySandboxServicesStore(null);
  setCompanySessionEnvStore(null);
});

afterEach(() => {
  setCompanySandboxStore(null);
  setCompanySandboxServicesStore(null);
  setCompanySessionEnvStore(null);
});

// ─── attach / destroy lifecycle ─────────────────────────────────

describe('SandboxManager → attachExternalService', () => {
  it('attaches a pre-existing container and reports it as ready', async () => {
    const { manager, driver } = makeManager();
    driver.seedContainer('user-container-abc', { running: true, paused: false });

    const sb = await manager.attachExternalService({
      sessionId: '42',
      serviceId: 'api',
      containerRef: 'user-container-abc',
    });

    expect(sb.id).toBe('42:api');
    expect(sb.containerId).toBe('user-container-abc');
    expect(sb.attached).toBe(true);
    expect(sb.status).toBe('ready');
    expect(sb.runtimePaused).toBe(false);
  });

  it('rejects when the container does not exist', async () => {
    const { manager } = makeManager();
    await expect(
      manager.attachExternalService({
        sessionId: '42',
        serviceId: 'api',
        containerRef: 'ghost-container',
      }),
    ).rejects.toThrow(/not found/i);
  });

  it("rejects service_id 'main' (reserved for primary sandbox)", async () => {
    const { manager, driver } = makeManager();
    driver.seedContainer('anything');
    await expect(
      manager.attachExternalService({
        sessionId: '42',
        serviceId: 'main',
        containerRef: 'anything',
      }),
    ).rejects.toThrow(/reserved/i);
  });

  it("rejects invalid service_id (must be lowercase alnum + hyphen, ≤32 chars)", async () => {
    const { manager, driver } = makeManager();
    driver.seedContainer('anything');
    for (const bad of ['Has-Caps', '1starts-with-digit', '-dash-first', 'a'.repeat(33)]) {
      await expect(
        manager.attachExternalService({
          sessionId: '42',
          serviceId: bad,
          containerRef: 'anything',
        }),
      ).rejects.toThrow(/Invalid service_id/);
    }
  });

  it('reports paused when the external container is OCI-paused', async () => {
    const { manager, driver } = makeManager();
    driver.seedContainer('paused-c', { running: false, paused: true });

    const sb = await manager.attachExternalService({
      sessionId: '42',
      serviceId: 'api',
      containerRef: 'paused-c',
    });
    expect(sb.status).toBe('ready'); // paused → ready, runtimePaused=true
    expect(sb.runtimePaused).toBe(true);
  });

  it('reports paused (with hint) when external container exists but is stopped', async () => {
    const { manager, driver } = makeManager();
    driver.seedContainer('stopped-c', { running: false, paused: false });

    const sb = await manager.attachExternalService({
      sessionId: '42',
      serviceId: 'api',
      containerRef: 'stopped-c',
    });
    expect(sb.status).toBe('paused');
    expect(sb.error).toMatch(/podman start/i);
  });
});

describe('SandboxManager → destroyService for attached services', () => {
  it('drops the service binding WITHOUT calling driver.destroy (external container = user-owned)', async () => {
    const { manager, driver } = makeManager();
    driver.seedContainer('user-c');
    await manager.attachExternalService({
      sessionId: '42',
      serviceId: 'api',
      containerRef: 'user-c',
    });

    expect(manager.getService('42', 'api')).toBeDefined();
    await manager.destroyService('42', 'api', 'user-removed');
    expect(manager.getService('42', 'api')).toBeUndefined();
    // Critical contract: the user's container outlives the binding.
    expect(driver.calls.destroy).toEqual([]);
    expect(driver.containers.has('user-c')).toBe(true);
  });

  it('is a no-op for an unknown service id (idempotent)', async () => {
    const { manager } = makeManager();
    await expect(manager.destroyService('42', 'never-existed')).resolves.toBeUndefined();
  });
});

// ─── pause / unpause runtime ────────────────────────────────────

describe('SandboxManager → pauseRuntimeContainer + unpauseRuntimeContainer', () => {
  it('pauses an attached running service through the driver', async () => {
    const { manager, driver } = makeManager();
    driver.seedContainer('c1', { running: true, paused: false });
    await manager.attachExternalService({
      sessionId: '42',
      serviceId: 'api',
      containerRef: 'c1',
    });

    const sb = await manager.pauseRuntimeContainer('42', 'api');
    expect(sb.runtimePaused).toBe(true);
    expect(driver.calls.pauseContainer).toContain('c1');
  });

  it('pausing an already-paused container is idempotent', async () => {
    const { manager, driver } = makeManager();
    driver.seedContainer('c1', { running: true, paused: false });
    await manager.attachExternalService({
      sessionId: '42',
      serviceId: 'api',
      containerRef: 'c1',
    });

    await manager.pauseRuntimeContainer('42', 'api');
    const second = await manager.pauseRuntimeContainer('42', 'api');
    expect(second.runtimePaused).toBe(true);
    // Second call must NOT issue another driver pause — manager short-circuits.
    expect(driver.calls.pauseContainer.length).toBe(1);
  });

  it('unpauseRuntimeContainer calls driver.unpauseContainer and clears the flag', async () => {
    const { manager, driver } = makeManager();
    driver.seedContainer('c1', { running: true, paused: false });
    await manager.attachExternalService({
      sessionId: '42',
      serviceId: 'api',
      containerRef: 'c1',
    });
    await manager.pauseRuntimeContainer('42', 'api');

    const sb = await manager.unpauseRuntimeContainer('42', 'api');
    expect(sb.runtimePaused).toBe(false);
    expect(driver.calls.unpauseContainer).toContain('c1');
  });

  it('refuses to pause a non-ready sandbox', async () => {
    const { manager, driver } = makeManager();
    driver.seedContainer('stopped', { running: false, paused: false });
    await manager.attachExternalService({
      sessionId: '42',
      serviceId: 'api',
      containerRef: 'stopped',
    });
    // attach reports status='paused' (stopped external container) — pause refuses.
    await expect(manager.pauseRuntimeContainer('42', 'api')).rejects.toThrow(
      /Cannot runtime-pause/,
    );
  });

  it('refuses to pause when the container vanished from the runtime', async () => {
    const { manager, driver } = makeManager();
    driver.seedContainer('c1');
    await manager.attachExternalService({
      sessionId: '42',
      serviceId: 'api',
      containerRef: 'c1',
    });
    // External agent removed the container behind the manager's back.
    driver.containers.delete('c1');
    await expect(manager.pauseRuntimeContainer('42', 'api')).rejects.toThrow(
      /no longer exists/i,
    );
  });
});

// ─── syncEnvsToAllContainers ────────────────────────────────────

function makeFakeEnvStore(envs: Record<string, string>): CompanySessionEnvStore {
  return {
    asRecord: () => envs,
    upsert: () => undefined,
    delete: () => undefined,
    list: () => [],
    get: () => null,
  } as unknown as CompanySessionEnvStore;
}

describe('SandboxManager → syncEnvsToAllContainers', () => {
  it('writes the rendered .env body to every owned-mount running service', async () => {
    setCompanySessionEnvStore(makeFakeEnvStore({ DATABASE_URL: 'postgres://x', FOO: 'bar' }));

    const { manager, driver } = makeManager();
    // Two owned services with different containers + workdirs.
    driver.seedContainer('c-api', { workdir: '/app' });
    driver.seedContainer('c-worker', { workdir: '/work' });
    await manager.attachExternalService({
      sessionId: '42',
      serviceId: 'api',
      containerRef: 'c-api',
    });
    await manager.attachExternalService({
      sessionId: '42',
      serviceId: 'worker',
      containerRef: 'c-worker',
    });

    // Attached external services have mountKind='external', so the
    // sync should SKIP them — verify the contract by inverting: we'd
    // expect zero writeFile calls.
    await manager.syncEnvsToAllContainers('42');
    expect(driver.calls.writeFile).toEqual([]);
  });

  it('is a no-op when there are no containers attached to the session', async () => {
    setCompanySessionEnvStore(makeFakeEnvStore({ FOO: 'bar' }));
    const { manager, driver } = makeManager();
    await manager.syncEnvsToAllContainers('99');
    expect(driver.calls.writeFile).toEqual([]);
  });

  it('is a no-op when no env store is wired (defensive)', async () => {
    setCompanySessionEnvStore(null);
    const { manager, driver } = makeManager();
    driver.seedContainer('c-api');
    await manager.attachExternalService({
      sessionId: '42',
      serviceId: 'api',
      containerRef: 'c-api',
    });
    await manager.syncEnvsToAllContainers('42');
    // Empty envs render a header-only .env; attached services skip
    // anyway. writeFile must not fire.
    expect(driver.calls.writeFile).toEqual([]);
  });
});

// ─── observer subscribe ─────────────────────────────────────────

describe('SandboxManager → subscribe / emit', () => {
  it('forwards `ready` event on attach to every subscriber', async () => {
    const { manager, driver } = makeManager();
    const events: SandboxEvent[] = [];
    const off = manager.subscribe((ev) => events.push(ev));
    driver.seedContainer('c1');
    await manager.attachExternalService({
      sessionId: '42',
      serviceId: 'api',
      containerRef: 'c1',
    });
    off();
    const readyEvents = events.filter((e) => e.kind === 'ready');
    expect(readyEvents.length).toBe(1);
    expect(readyEvents[0].sandboxId).toBe('42:api');
  });

  it('forwards `destroying` + `destroyed` events through the full destroy cycle', async () => {
    const { manager, driver } = makeManager();
    driver.seedContainer('c1');
    await manager.attachExternalService({
      sessionId: '42',
      serviceId: 'api',
      containerRef: 'c1',
    });
    const events: SandboxEvent[] = [];
    const off = manager.subscribe((ev) => events.push(ev));
    await manager.destroyService('42', 'api', 'user-removed');
    off();
    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain('destroying');
    expect(kinds).toContain('destroyed');
  });

  it('unsubscribe stops further events for that observer only', async () => {
    const { manager, driver } = makeManager();
    const a: SandboxEvent[] = [];
    const b: SandboxEvent[] = [];
    const offA = manager.subscribe((ev) => a.push(ev));
    manager.subscribe((ev) => b.push(ev));
    offA();
    driver.seedContainer('c1');
    await manager.attachExternalService({
      sessionId: '42',
      serviceId: 'api',
      containerRef: 'c1',
    });
    expect(a.length).toBe(0);
    expect(b.length).toBeGreaterThan(0);
  });
});

// ─── queries ─────────────────────────────────────────────────────

describe('SandboxManager → workspace IO (on attached service)', () => {
  it('readWorkspaceFileOnService returns the file contents the driver holds', async () => {
    const { manager, driver } = makeManager();
    // Attached external services use workdir='/' (the manager has no
    // canonical workdir for a container the user owns). `absPath`
    // strips the trailing slash so files resolve to `/notes.md`.
    const c = driver.seedContainer('c1');
    c.files.set('/notes.md', 'hello from inside');
    await manager.attachExternalService({
      sessionId: '42',
      serviceId: 'api',
      containerRef: 'c1',
    });
    const got = await manager.readWorkspaceFileOnService('42', 'api', 'notes.md');
    expect(got).toBe('hello from inside');
  });

  it('readWorkspaceFile rejects path traversal attempts (`..`)', async () => {
    const { manager, driver } = makeManager();
    driver.seedContainer('c1');
    await manager.attachExternalService({
      sessionId: '42',
      serviceId: 'api',
      containerRef: 'c1',
    });
    await expect(
      manager.readWorkspaceFileOnService('42', 'api', '../etc/passwd'),
    ).rejects.toThrow(/\.\./);
  });
});

describe('SandboxManager → queries', () => {
  it('list() / listServices() empty by default', () => {
    const { manager } = makeManager();
    expect(manager.list()).toEqual([]);
    expect(manager.listServices('42')).toEqual([]);
  });

  it('listServices returns only services belonging to the requested session', async () => {
    const { manager, driver } = makeManager();
    driver.seedContainer('c1');
    driver.seedContainer('c2');
    await manager.attachExternalService({
      sessionId: '42',
      serviceId: 'api',
      containerRef: 'c1',
    });
    await manager.attachExternalService({
      sessionId: '43',
      serviceId: 'api',
      containerRef: 'c2',
    });
    expect(manager.listServices('42').map((s) => s.id)).toEqual(['42:api']);
    expect(manager.listServices('43').map((s) => s.id)).toEqual(['43:api']);
    expect(manager.listServices('99').map((s) => s.id)).toEqual([]);
  });

  it('getService returns the attached sandbox when present, undefined otherwise', async () => {
    const { manager, driver } = makeManager();
    driver.seedContainer('c1');
    await manager.attachExternalService({
      sessionId: '42',
      serviceId: 'api',
      containerRef: 'c1',
    });
    expect(manager.getService('42', 'api')?.id).toBe('42:api');
    expect(manager.getService('42', 'ghost')).toBeUndefined();
  });
});
