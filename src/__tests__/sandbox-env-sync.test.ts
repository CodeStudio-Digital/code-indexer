import { describe, it, expect, vi } from 'vitest';
import {
  collectEnvSyncTargets,
  pushEnvsToContainers,
} from '@mcp/services/sandbox/manager/env-sync.js';
import type { Sandbox } from '@mcp/services/sandbox/types.js';
import type { ISandboxDriver } from '@mcp/services/sandbox/ports/sandbox-driver.js';

function makeSandbox(overrides: Partial<Sandbox> = {}): Sandbox {
  return {
    id: '42:test',
    containerId: 'c1',
    runtime: 'docker',
    stack: 'react-ts',
    hostPort: 0,
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

// ─── collectEnvSyncTargets ──────────────────────────────────────

describe('collectEnvSyncTargets', () => {
  it('returns empty array when nothing eligible', () => {
    expect(collectEnvSyncTargets(undefined, [])).toEqual([]);
  });

  it('includes a healthy owned primary as serviceId "main"', () => {
    const primary = makeSandbox({ containerId: 'p1', workdir: '/app' });
    expect(collectEnvSyncTargets(primary, [])).toEqual([
      { serviceId: 'main', containerId: 'p1', workdir: '/app' },
    ]);
  });

  it('skips a primary with no containerId', () => {
    const primary = makeSandbox({ containerId: '' });
    expect(collectEnvSyncTargets(primary, [])).toEqual([]);
  });

  it('skips a runtime-paused primary', () => {
    const primary = makeSandbox({ containerId: 'p1', runtimePaused: true });
    expect(collectEnvSyncTargets(primary, [])).toEqual([]);
  });

  it('skips an external-mount primary', () => {
    const primary = makeSandbox({ containerId: 'p1', mountKind: 'external' });
    expect(collectEnvSyncTargets(primary, [])).toEqual([]);
  });

  it('includes healthy services alongside primary, carrying their serviceId', () => {
    const primary = makeSandbox({ containerId: 'p1', workdir: '/app' });
    const api = makeSandbox({ id: '42:api', containerId: 'c-api', workdir: '/svc-api' });
    const worker = makeSandbox({
      id: '42:worker',
      containerId: 'c-worker',
      workdir: '/svc-worker',
    });
    expect(
      collectEnvSyncTargets(primary, [
        { serviceId: 'api', sandbox: api },
        { serviceId: 'worker', sandbox: worker },
      ]),
    ).toEqual([
      { serviceId: 'main', containerId: 'p1', workdir: '/app' },
      { serviceId: 'api', containerId: 'c-api', workdir: '/svc-api' },
      { serviceId: 'worker', containerId: 'c-worker', workdir: '/svc-worker' },
    ]);
  });

  it('filters out paused / external services individually', () => {
    const primary = makeSandbox({ containerId: 'p1' });
    const paused = makeSandbox({
      id: '42:paused',
      containerId: 'c-paused',
      runtimePaused: true,
    });
    const external = makeSandbox({
      id: '42:ext',
      containerId: 'c-ext',
      mountKind: 'external',
    });
    const healthy = makeSandbox({ id: '42:ok', containerId: 'c-ok', workdir: '/ok' });
    const out = collectEnvSyncTargets(primary, [
      { serviceId: 'paused', sandbox: paused },
      { serviceId: 'ext', sandbox: external },
      { serviceId: 'ok', sandbox: healthy },
    ]);
    expect(out.map((t) => t.containerId)).toEqual(['p1', 'c-ok']);
  });
});

// ─── pushEnvsToContainers ───────────────────────────────────────

describe('pushEnvsToContainers', () => {
  function mockDriver(): ISandboxDriver {
    return {
      writeFile: vi.fn().mockResolvedValue(undefined),
    } as unknown as ISandboxDriver;
  }

  it('writes a PER-SERVICE rendered .env body to every target with `recursive: true`', async () => {
    const driver = mockDriver();
    const bodyFor = vi.fn((serviceId: string) => `SVC=${serviceId}\n`);
    await pushEnvsToContainers(
      [
        { serviceId: 'main', containerId: 'a', workdir: '/app' },
        { serviceId: 'api', containerId: 'b', workdir: '/work' },
      ],
      bodyFor,
      driver,
    );
    const writeFile = driver.writeFile as ReturnType<typeof vi.fn>;
    expect(writeFile).toHaveBeenCalledTimes(2);
    expect(writeFile).toHaveBeenCalledWith('a', '/app/.env', 'SVC=main\n', { recursive: true });
    expect(writeFile).toHaveBeenCalledWith('b', '/work/.env', 'SVC=api\n', { recursive: true });
    expect(bodyFor).toHaveBeenCalledWith('main');
    expect(bodyFor).toHaveBeenCalledWith('api');
  });

  it('is a no-op when targets is empty', async () => {
    const driver = mockDriver();
    await pushEnvsToContainers([], () => 'FOO=bar\n', driver);
    expect(driver.writeFile).not.toHaveBeenCalled();
  });

  it('is a no-op when driver is null', async () => {
    // No driver = no targets to write to; the call must resolve cleanly.
    await expect(
      pushEnvsToContainers(
        [{ serviceId: 'main', containerId: 'a', workdir: '/app' }],
        () => 'FOO=bar\n',
        null,
      ),
    ).resolves.toBeUndefined();
  });

  it('does not throw when one target fails (Promise.allSettled semantics)', async () => {
    const writeFile = vi
      .fn()
      .mockImplementationOnce(() => Promise.reject(new Error('broken')))
      .mockResolvedValueOnce(undefined);
    const driver = { writeFile } as unknown as ISandboxDriver;
    await expect(
      pushEnvsToContainers(
        [
          { serviceId: 'main', containerId: 'broken', workdir: '/app' },
          { serviceId: 'api', containerId: 'ok', workdir: '/app' },
        ],
        () => 'FOO=bar\n',
        driver,
      ),
    ).resolves.toBeUndefined();
    expect(writeFile).toHaveBeenCalledTimes(2);
  });
});
