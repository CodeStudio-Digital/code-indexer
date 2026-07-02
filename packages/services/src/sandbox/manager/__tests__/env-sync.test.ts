/**
 * env-sync — per-service `.env` materialization (D1).
 *
 * Pure-module test (fake Sandbox shapes + fake driver): pins that
 *   - targets carry the service id ('main' = primary) and keep the
 *     legacy skip rules (external mount, runtime-paused, containerless);
 *   - `pushEnvsToContainers` renders EACH container's body via
 *     `bodyFor(serviceId)` — the hook where `service_scope` filtering
 *     plugs in — instead of one shared body for all.
 */
import { describe, expect, it, vi } from 'vitest';
import type { Sandbox } from '@mcp/services/sandbox/types.js';
import type { ISandboxDriver } from '@mcp/services/sandbox/ports/sandbox-driver.js';
import { collectEnvSyncTargets, pushEnvsToContainers } from '../env-sync.js';

function sb(over: Partial<Sandbox>): Sandbox {
  return {
    id: 'x',
    containerId: 'ctr',
    workdir: '/app',
    runtimePaused: false,
    mountKind: 'owned',
    ...over,
  } as unknown as Sandbox;
}

describe('collectEnvSyncTargets', () => {
  it("labels the primary 'main' and services by their id", () => {
    const targets = collectEnvSyncTargets(sb({ containerId: 'c-main' }), [
      { serviceId: 'api', sandbox: sb({ containerId: 'c-api' }) },
    ]);
    expect(targets).toEqual([
      { serviceId: 'main', containerId: 'c-main', workdir: '/app' },
      { serviceId: 'api', containerId: 'c-api', workdir: '/app' },
    ]);
  });

  it('skips external mounts, paused runtimes, and containerless entries', () => {
    const targets = collectEnvSyncTargets(sb({ mountKind: 'external' }), [
      { serviceId: 'paused', sandbox: sb({ runtimePaused: true }) },
      { serviceId: 'ghost', sandbox: sb({ containerId: '' }) },
      { serviceId: 'ok', sandbox: sb({ containerId: 'c-ok' }) },
    ]);
    expect(targets).toEqual([{ serviceId: 'ok', containerId: 'c-ok', workdir: '/app' }]);
  });

  it('handles a missing primary (services-only session)', () => {
    const targets = collectEnvSyncTargets(undefined, [
      { serviceId: 'api', sandbox: sb({ containerId: 'c-api' }) },
    ]);
    expect(targets).toEqual([{ serviceId: 'api', containerId: 'c-api', workdir: '/app' }]);
  });
});

describe('pushEnvsToContainers — per-service bodies', () => {
  function fakeDriver() {
    const writeFile = vi.fn(async () => undefined);
    return { driver: { writeFile } as unknown as ISandboxDriver, writeFile };
  }

  it('renders each body with the target service id (scope enforcement hook)', async () => {
    const { driver, writeFile } = fakeDriver();
    await pushEnvsToContainers(
      [
        { serviceId: 'main', containerId: 'c-main', workdir: '/app' },
        { serviceId: 'api', containerId: 'c-api', workdir: '/srv' },
      ],
      (serviceId) => `# env for ${serviceId}`,
      driver,
    );
    expect(writeFile).toHaveBeenCalledTimes(2);
    expect(writeFile).toHaveBeenCalledWith('c-main', '/app/.env', '# env for main', {
      recursive: true,
    });
    expect(writeFile).toHaveBeenCalledWith('c-api', '/srv/.env', '# env for api', {
      recursive: true,
    });
  });

  it('is a clean no-op without driver or targets', async () => {
    const { driver, writeFile } = fakeDriver();
    await pushEnvsToContainers([], () => '', driver);
    expect(writeFile).not.toHaveBeenCalled();
    await expect(
      pushEnvsToContainers(
        [{ serviceId: 'main', containerId: 'c', workdir: '/app' }],
        () => '',
        null,
      ),
    ).resolves.toBeUndefined();
  });

  it('one failing container does not block the rest (allSettled)', async () => {
    const writeFile = vi
      .fn(async () => undefined)
      .mockRejectedValueOnce(new Error('boom'));
    const driver = { writeFile } as unknown as ISandboxDriver;
    await expect(
      pushEnvsToContainers(
        [
          { serviceId: 'main', containerId: 'c1', workdir: '/app' },
          { serviceId: 'api', containerId: 'c2', workdir: '/app' },
        ],
        () => 'body',
        driver,
      ),
    ).resolves.toBeUndefined();
    expect(writeFile).toHaveBeenCalledTimes(2);
  });
});
