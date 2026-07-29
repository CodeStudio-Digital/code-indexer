import { describe, it, expect, vi } from 'vitest';
import {
  resolveRuntimePauseTarget,
  runtimePauseContainer,
  runtimeUnpauseContainer,
  type RuntimePauseDeps,
} from '@mcp/services/sandbox/manager/runtime-pause.js';
import { SandboxRegistry } from '@mcp/services/sandbox/manager/state/registry.js';
import type { Sandbox } from '@mcp/services/sandbox/types.js';
import { FakeSandboxDriver } from './helpers/fake-sandbox-driver.js';

const SESSION_ID = '00000000-0000-4000-8000-000000000042';

function makeSandbox(overrides: Partial<Sandbox> = {}): Sandbox {
  return {
    id: `${SESSION_ID}:test`,
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

function makeDeps(): RuntimePauseDeps & {
  logs: Array<{ level: string; text: string }>;
  persistCalls: Array<{ sessionId: string; serviceId: string | null; runtimePaused: boolean }>;
} {
  const logs: Array<{ level: string; text: string }> = [];
  const persistCalls: Array<{
    sessionId: string;
    serviceId: string | null;
    runtimePaused: boolean;
  }> = [];
  return {
    appendLog: (_sb, level, text) => logs.push({ level, text }),
    persistRuntimePauseState: (sessionId, serviceId, sb) =>
      persistCalls.push({
        sessionId,
        serviceId,
        runtimePaused: sb.runtimePaused ?? false,
      }),
    logs,
    persistCalls,
  };
}

// ─── resolveRuntimePauseTarget ──────────────────────────────────

describe('resolveRuntimePauseTarget', () => {
  it('returns the primary when serviceId is undefined', () => {
    const reg = new SandboxRegistry();
    const sb = makeSandbox({ id: SESSION_ID });
    reg.primary.set(SESSION_ID, sb);
    expect(resolveRuntimePauseTarget(reg, SESSION_ID)).toEqual({ sb, serviceId: null });
  });

  it("returns the primary when serviceId is 'main'", () => {
    const reg = new SandboxRegistry();
    const sb = makeSandbox({ id: SESSION_ID });
    reg.primary.set(SESSION_ID, sb);
    expect(resolveRuntimePauseTarget(reg, SESSION_ID, 'main')).toEqual({ sb, serviceId: null });
  });

  it('returns the named service for non-main serviceId', () => {
    const reg = new SandboxRegistry();
    const sb = makeSandbox({ id: `${SESSION_ID}:api` });
    reg.setService(SESSION_ID, 'api', sb);
    expect(resolveRuntimePauseTarget(reg, SESSION_ID, 'api')).toEqual({ sb, serviceId: 'api' });
  });

  it('throws with a descriptive message when no primary is registered', () => {
    const reg = new SandboxRegistry();
    expect(() => resolveRuntimePauseTarget(reg, SESSION_ID)).toThrow(
      new RegExp(`No sandbox for session ${SESSION_ID}`),
    );
  });

  it('throws with a descriptive message when the service is unknown', () => {
    const reg = new SandboxRegistry();
    expect(() => resolveRuntimePauseTarget(reg, SESSION_ID, 'ghost')).toThrow(
      new RegExp(`No service 'ghost' for session ${SESSION_ID}`),
    );
  });
});

// ─── runtimePauseContainer ──────────────────────────────────────

describe('runtimePauseContainer', () => {
  it('idempotent when already paused — no driver call, no log, returns same sandbox', async () => {
    const driver = new FakeSandboxDriver();
    const sb = makeSandbox({ runtimePaused: true });
    const deps = makeDeps();
    const out = await runtimePauseContainer(SESSION_ID, null, sb, driver, deps);
    expect(out).toBe(sb);
    expect(driver.calls.pauseContainer).toEqual([]);
    expect(deps.logs).toEqual([]);
    expect(deps.persistCalls).toEqual([]);
  });

  it('rejects non-ready sandboxes', async () => {
    const driver = new FakeSandboxDriver();
    const sb = makeSandbox({ status: 'provisioning' });
    await expect(
      runtimePauseContainer(SESSION_ID, null, sb, driver, makeDeps()),
    ).rejects.toThrow(/Cannot runtime-pause/);
  });

  it('rejects sandboxes with empty containerId', async () => {
    const driver = new FakeSandboxDriver();
    const sb = makeSandbox({ containerId: '' });
    await expect(
      runtimePauseContainer(SESSION_ID, null, sb, driver, makeDeps()),
    ).rejects.toThrow(/No container id/);
  });

  it('rejects when the container vanished from the runtime', async () => {
    const driver = new FakeSandboxDriver();
    const sb = makeSandbox({ containerId: 'gone' });
    await expect(
      runtimePauseContainer(SESSION_ID, null, sb, driver, makeDeps()),
    ).rejects.toThrow(/no longer exists/i);
  });

  it('rejects when the container exists but is not running', async () => {
    const driver = new FakeSandboxDriver();
    driver.seedContainer('c1', { running: false, paused: false });
    const sb = makeSandbox({ containerId: 'c1' });
    await expect(
      runtimePauseContainer(SESSION_ID, null, sb, driver, makeDeps()),
    ).rejects.toThrow(/not running/);
  });

  it('reconciles `inspect.paused` (drift): sets runtimePaused without calling driver again', async () => {
    const driver = new FakeSandboxDriver();
    driver.seedContainer('c1', { running: false, paused: true });
    const sb = makeSandbox({ containerId: 'c1' });
    const deps = makeDeps();
    const out = await runtimePauseContainer(SESSION_ID, null, sb, driver, deps);
    expect(out.runtimePaused).toBe(true);
    expect(driver.calls.pauseContainer).toEqual([]); // already paused; we don't re-call
    expect(deps.persistCalls[0]?.runtimePaused).toBe(true);
  });

  it('happy path: pauses live container, logs, persists', async () => {
    const driver = new FakeSandboxDriver();
    driver.seedContainer('c1', { running: true, paused: false });
    const sb = makeSandbox({ containerId: 'c1' });
    const deps = makeDeps();
    const out = await runtimePauseContainer(SESSION_ID, 'api', sb, driver, deps);
    expect(out.runtimePaused).toBe(true);
    expect(driver.calls.pauseContainer).toEqual(['c1']);
    expect(deps.logs).toEqual([{ level: 'info', text: 'Runtime pause requested.' }]);
    expect(deps.persistCalls).toEqual([
      { sessionId: SESSION_ID, serviceId: 'api', runtimePaused: true },
    ]);
  });

  it('bumps lastAccessAt on success', async () => {
    const driver = new FakeSandboxDriver();
    driver.seedContainer('c1', { running: true });
    const original = Date.now() - 60_000;
    const sb = makeSandbox({ containerId: 'c1', lastAccessAt: original });
    await runtimePauseContainer(SESSION_ID, null, sb, driver, makeDeps());
    expect(sb.lastAccessAt).toBeGreaterThan(original);
  });
});

// ─── runtimeUnpauseContainer ────────────────────────────────────

describe('runtimeUnpauseContainer', () => {
  it('happy path: unpauses, clears flag, logs, persists', async () => {
    const driver = new FakeSandboxDriver();
    driver.seedContainer('c1', { running: false, paused: true });
    const sb = makeSandbox({ containerId: 'c1', runtimePaused: true });
    const deps = makeDeps();
    const out = await runtimeUnpauseContainer(SESSION_ID, 'api', sb, driver, deps);
    expect(out.runtimePaused).toBe(false);
    expect(driver.calls.unpauseContainer).toEqual(['c1']);
    expect(deps.logs).toEqual([{ level: 'info', text: 'Runtime unpause requested.' }]);
    expect(deps.persistCalls).toEqual([
      { sessionId: SESSION_ID, serviceId: 'api', runtimePaused: false },
    ]);
  });

  it('rejects when the container vanished from the runtime', async () => {
    const driver = new FakeSandboxDriver();
    const sb = makeSandbox({ containerId: 'gone' });
    await expect(
      runtimeUnpauseContainer(SESSION_ID, null, sb, driver, makeDeps()),
    ).rejects.toThrow(/no longer exists/i);
  });

  it('rejects when both flags say "not paused" but the container is not running', async () => {
    const driver = new FakeSandboxDriver();
    driver.seedContainer('c1', { running: false, paused: false });
    const sb = makeSandbox({ containerId: 'c1', runtimePaused: false });
    await expect(
      runtimeUnpauseContainer(SESSION_ID, null, sb, driver, makeDeps()),
    ).rejects.toThrow(/not running/);
  });

  it('unpause called even when only `sb.runtimePaused` is set (drift recovery)', async () => {
    const driver = new FakeSandboxDriver();
    driver.seedContainer('c1', { running: true, paused: false });
    const sb = makeSandbox({ containerId: 'c1', runtimePaused: true });
    const deps = makeDeps();
    await runtimeUnpauseContainer(SESSION_ID, null, sb, driver, deps);
    expect(driver.calls.unpauseContainer).toEqual(['c1']);
  });

  it('rejects empty containerId', async () => {
    const driver = new FakeSandboxDriver();
    const sb = makeSandbox({ containerId: '' });
    await expect(
      runtimeUnpauseContainer(SESSION_ID, null, sb, driver, makeDeps()),
    ).rejects.toThrow(/No container id/);
  });

  it('sets step back to "ready" when the sandbox status is ready', async () => {
    const driver = new FakeSandboxDriver();
    driver.seedContainer('c1', { running: false, paused: true });
    const sb = makeSandbox({
      containerId: 'c1',
      runtimePaused: true,
      status: 'ready',
      step: 'queued',
    });
    const out = await runtimeUnpauseContainer(SESSION_ID, null, sb, driver, makeDeps());
    expect(out.step).toBe('ready');
  });
});

// ─── ensure no observable timing change vs. the old class method ─

describe('runtime-pause module — order of operations contract', () => {
  it('pauseContainer is called BEFORE persistRuntimePauseState', async () => {
    const driver = new FakeSandboxDriver();
    driver.seedContainer('c1', { running: true });
    const sb = makeSandbox({ containerId: 'c1' });
    const order: string[] = [];
    const pauseSpy = vi.spyOn(driver, 'pauseContainer').mockImplementation(async (id) => {
      order.push(`pause:${id}`);
    });
    const deps: RuntimePauseDeps = {
      appendLog: () => undefined,
      persistRuntimePauseState: () => order.push('persist'),
    };
    await runtimePauseContainer(SESSION_ID, null, sb, driver, deps);
    expect(order).toEqual(['pause:c1', 'persist']);
    pauseSpy.mockRestore();
  });

  it('unpauseContainer is called BEFORE persistRuntimePauseState', async () => {
    const driver = new FakeSandboxDriver();
    driver.seedContainer('c1', { running: false, paused: true });
    const sb = makeSandbox({ containerId: 'c1', runtimePaused: true });
    const order: string[] = [];
    const unpauseSpy = vi.spyOn(driver, 'unpauseContainer').mockImplementation(async (id) => {
      order.push(`unpause:${id}`);
    });
    const deps: RuntimePauseDeps = {
      appendLog: () => undefined,
      persistRuntimePauseState: () => order.push('persist'),
    };
    await runtimeUnpauseContainer(SESSION_ID, null, sb, driver, deps);
    expect(order).toEqual(['unpause:c1', 'persist']);
    unpauseSpy.mockRestore();
  });
});
