import { describe, it, expect, vi } from 'vitest';
import {
  executeServiceDestroy,
  shouldHardDeleteService,
  type DestroyServiceDeps,
} from '@mcp/services/sandbox/manager/destroy-service.js';
import { SandboxRegistry } from '@mcp/services/sandbox/manager/state/registry.js';
import type { Sandbox, SandboxEvent } from '@mcp/services/sandbox/types.js';
import { FakeSandboxDriver } from './helpers/fake-sandbox-driver.js';

function makeSandbox(overrides: Partial<Sandbox> = {}): Sandbox {
  return {
    id: '42:test',
    containerId: 'c1',
    runtime: 'docker',
    stack: 'react-ts',
    hostPort: 12345,
    workdir: '/app',
    containerPort: 5173,
    previewUrl: '',
    limits: {},
    status: 'ready',
    runtimePaused: false,
    step: 'ready',
    recentLogs: [],
    createdAt: Date.now(),
    lastAccessAt: Date.now(),
    mountKind: 'owned',
    imageSource: 'default',
    ...overrides,
  } as Sandbox;
}

function makeHarness() {
  const registry = new SandboxRegistry();
  const events: SandboxEvent[] = [];
  const released: number[] = [];
  const syncManagedEnvsCalls: string[] = [];
  const syncEnvsCalls: string[] = [];
  const destroyedNetworks: string[] = [];
  const driver = new FakeSandboxDriver();
  const storeOps: Array<{ kind: 'delete' | 'patch'; sessionId: number; serviceId: string }> = [];
  const servicesStore = {
    delete: vi.fn((sid: number, svc: string) => {
      storeOps.push({ kind: 'delete', sessionId: sid, serviceId: svc });
    }),
    patch: vi.fn((sid: number, svc: string) => {
      storeOps.push({ kind: 'patch', sessionId: sid, serviceId: svc });
    }),
  };
  const deps: DestroyServiceDeps = {
    driver,
    registry,
    allocator: { release: (port) => released.push(port) },
    servicesStore: servicesStore as never,
    emit: (ev) => events.push(ev),
    syncManagedEnvs: (sid) => syncManagedEnvsCalls.push(sid),
    syncEnvsToAllContainers: async (sid) => {
      syncEnvsCalls.push(sid);
    },
    destroySessionNetwork: async (sid) => {
      destroyedNetworks.push(sid);
    },
  };
  return {
    registry,
    driver,
    deps,
    events,
    released,
    syncManagedEnvsCalls,
    syncEnvsCalls,
    destroyedNetworks,
    servicesStore,
    storeOps,
  };
}

// ─── shouldHardDeleteService ────────────────────────────────────

describe('shouldHardDeleteService', () => {
  it("hard-deletes for 'user-removed'", () => {
    expect(shouldHardDeleteService('user-removed')).toBe(true);
  });

  it("hard-deletes for 'user-removed-offline'", () => {
    expect(shouldHardDeleteService('user-removed-offline')).toBe(true);
  });

  it("keeps tombstone for transient reasons (retry, abort, reaper, TTL)", () => {
    expect(shouldHardDeleteService('retry')).toBe(false);
    expect(shouldHardDeleteService('abort')).toBe(false);
    expect(shouldHardDeleteService('idle-ttl')).toBe(false);
    expect(shouldHardDeleteService('session-end')).toBe(false);
    expect(shouldHardDeleteService('explicit')).toBe(false);
  });
});

// ─── executeServiceDestroy — happy paths ────────────────────────

describe('executeServiceDestroy', () => {
  it('no-op when the service does not exist in the registry', async () => {
    const h = makeHarness();
    await executeServiceDestroy('42', 'ghost', 'user-removed', h.deps);
    expect(h.events).toEqual([]);
    expect(h.released).toEqual([]);
    expect(h.storeOps).toEqual([]);
  });

  it('owned container: calls driver.destroy + releases port + emits destroying/destroyed', async () => {
    const h = makeHarness();
    h.driver.seedContainer('c1');
    const sb = makeSandbox({ containerId: 'c1', hostPort: 34567 });
    h.registry.setService('42', 'api', sb);

    await executeServiceDestroy('42', 'api', 'user-removed', h.deps);

    expect(h.driver.calls.destroy).toEqual(['c1']);
    expect(h.released).toEqual([34567]);
    expect(h.registry.getService('42', 'api')).toBeUndefined();
    expect(sb.status).toBe('destroyed');
    const kinds = h.events.map((e) => e.kind);
    expect(kinds).toEqual(['destroying', 'destroyed']);
  });

  it('attached container: SKIPS driver.destroy (user owns the container)', async () => {
    const h = makeHarness();
    h.driver.seedContainer('c1');
    const sb = makeSandbox({ containerId: 'c1', attached: true });
    h.registry.setService('42', 'api', sb);

    await executeServiceDestroy('42', 'api', 'user-removed', h.deps);

    expect(h.driver.calls.destroy).toEqual([]);
    expect(h.driver.containers.has('c1')).toBe(true);
    expect(h.registry.getService('42', 'api')).toBeUndefined();
  });

  it('hard-deletes the persisted row for user-removed reasons', async () => {
    const h = makeHarness();
    const sb = makeSandbox({ containerId: 'c1' });
    h.registry.setService('42', 'api', sb);
    h.driver.seedContainer('c1');

    await executeServiceDestroy('42', 'api', 'user-removed', h.deps);

    expect(h.servicesStore.delete).toHaveBeenCalledWith(42, 'api');
    expect(h.servicesStore.patch).not.toHaveBeenCalled();
  });

  it('soft-deletes (patch status=destroyed) for transient reasons (retry/reaper/abort)', async () => {
    const h = makeHarness();
    h.driver.seedContainer('c1');
    const sb = makeSandbox({ containerId: 'c1' });
    h.registry.setService('42', 'api', sb);

    await executeServiceDestroy('42', 'api', 'retry', h.deps);

    expect(h.servicesStore.patch).toHaveBeenCalledWith(
      42,
      'api',
      expect.objectContaining({ status: 'destroyed', container_id: 'c1' }),
    );
    expect(h.servicesStore.delete).not.toHaveBeenCalled();
  });

  it('always re-syncs managed envs + container envs after teardown', async () => {
    const h = makeHarness();
    h.driver.seedContainer('c1');
    h.registry.setService('42', 'api', makeSandbox({ containerId: 'c1' }));

    await executeServiceDestroy('42', 'api', 'user-removed', h.deps);

    expect(h.syncManagedEnvsCalls).toEqual(['42']);
    // syncEnvsToAllContainers fires as fire-and-forget — its promise is `void`d.
    // We assert the call happened but don't await it explicitly (the test
    // env runs the microtask before assertion).
    expect(h.syncEnvsCalls).toEqual(['42']);
  });

  it('drops the shared docker network when no primary + no services remain', async () => {
    const h = makeHarness();
    h.driver.seedContainer('c1');
    h.registry.setService('42', 'only-svc', makeSandbox({ containerId: 'c1' }));
    // No primary registered → after destroy, session is empty.

    await executeServiceDestroy('42', 'only-svc', 'user-removed', h.deps);

    expect(h.destroyedNetworks).toEqual(['42']);
  });

  it('KEEPS the shared docker network while the primary is still up', async () => {
    const h = makeHarness();
    h.driver.seedContainer('p1');
    h.driver.seedContainer('c1');
    h.registry.primary.set('42', makeSandbox({ id: '42', containerId: 'p1' }));
    h.registry.setService('42', 'api', makeSandbox({ containerId: 'c1' }));

    await executeServiceDestroy('42', 'api', 'user-removed', h.deps);

    expect(h.destroyedNetworks).toEqual([]);
  });

  it('KEEPS the shared docker network while another sibling service is up', async () => {
    const h = makeHarness();
    h.driver.seedContainer('c1');
    h.driver.seedContainer('c2');
    h.registry.setService('42', 'api', makeSandbox({ containerId: 'c1' }));
    h.registry.setService('42', 'worker', makeSandbox({ containerId: 'c2' }));

    await executeServiceDestroy('42', 'api', 'user-removed', h.deps);

    expect(h.destroyedNetworks).toEqual([]);
  });

  it('emits `destroyed` event even when driver.destroy throws', async () => {
    const h = makeHarness();
    h.driver.seedContainer('c1');
    h.registry.setService('42', 'api', makeSandbox({ containerId: 'c1' }));
    const destroySpy = vi
      .spyOn(h.driver, 'destroy')
      .mockRejectedValueOnce(new Error('runtime gone'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await executeServiceDestroy('42', 'api', 'user-removed', h.deps);

    expect(h.events.map((e) => e.kind)).toEqual(['destroying', 'destroyed']);
    expect(h.registry.getService('42', 'api')).toBeUndefined();
    destroySpy.mockRestore();
    warn.mockRestore();
  });

  it('skips persistence when servicesStore is null', async () => {
    const h = makeHarness();
    h.driver.seedContainer('c1');
    h.registry.setService('42', 'api', makeSandbox({ containerId: 'c1' }));
    const depsNoStore = { ...h.deps, servicesStore: null };

    await expect(
      executeServiceDestroy('42', 'api', 'user-removed', depsNoStore),
    ).resolves.toBeUndefined();
    expect(h.events.map((e) => e.kind)).toEqual(['destroying', 'destroyed']);
  });

  it('skips persistence when sessionId is not numeric', async () => {
    const h = makeHarness();
    h.driver.seedContainer('c1');
    h.registry.setService('abc', 'api', makeSandbox({ containerId: 'c1' }));

    await executeServiceDestroy('abc', 'api', 'user-removed', h.deps);

    expect(h.servicesStore.delete).not.toHaveBeenCalled();
    expect(h.servicesStore.patch).not.toHaveBeenCalled();
  });

  it('order: destroying → driver.destroy → port released → registry deleted → destroyed', async () => {
    const h = makeHarness();
    h.driver.seedContainer('c1');
    h.registry.setService('42', 'api', makeSandbox({ containerId: 'c1' }));
    const log: string[] = [];
    const origDestroy = h.driver.destroy.bind(h.driver);
    h.driver.destroy = async (id: string) => {
      log.push(`driver.destroy:${id}`);
      return origDestroy(id);
    };
    h.deps.allocator.release = (port: number) => log.push(`release:${port}`);
    h.deps.emit = (ev: SandboxEvent) => log.push(`emit:${ev.kind}`);

    await executeServiceDestroy('42', 'api', 'user-removed', h.deps);

    expect(log).toEqual([
      'emit:destroying',
      'driver.destroy:c1',
      'release:12345',
      'emit:destroyed',
    ]);
  });
});
