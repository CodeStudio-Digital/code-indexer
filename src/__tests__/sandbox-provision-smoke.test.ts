/**
 * Smoke test for `SandboxManager.provision()` — the big monster
 * extracted in Frente C. Uses:
 *   - `FakeSandboxDriver` (in-memory containers, see helpers/).
 *   - `FakeScaffolder` registered via `registerScaffolder`.
 *   - `setNetworkControllerForTests(stub)` to bypass podman network creation.
 *
 * What this covers:
 *   - Happy path: seed → create container → scaffolder → ready.
 *   - Idempotency: a second `provision` returns the existing record.
 *   - Concurrency cap: provisions past `maxSandboxes` throw.
 *   - Error path: a scaffolder throw leaves the record in 'error' state
 *     (NOT destroyed) so the UI can show context for retry.
 *
 * What this does NOT cover:
 *   - The real scaffolder's filesystem effects.
 *   - `provisionAdditionalService` (separate smoke).
 *   - Reconcile-from-DB on boot.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SandboxManager,
  setCompanySandboxStore,
  setCompanySandboxServicesStore,
  setCompanySessionEnvStore,
} from '@mcp/services/sandbox/sandbox-manager.js';
import { PortAllocator } from '@mcp/services/sandbox/port-allocator.js';
import {
  registerScaffolder,
} from '@mcp/services/sandbox/scaffolders/registry.js';
import { setNetworkControllerForTests } from '@mcp/services/sandbox/network-controller.js';
import type { NetworkController } from '@mcp/services/sandbox/network-controller.js';
import { setSandboxArchiveBundleResolver } from '@mcp/services/sandbox/archive.js';
import { FakeSandboxDriver } from './helpers/fake-sandbox-driver.js';
import { FakeScaffolder } from './helpers/fake-scaffolder.js';

function sessionId(index: number): string {
  return `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
}

/**
 * Bypass the egress firewall — `ensure()` returning null tells the
 * manager to leave isolation.network at its own default (no docker
 * network creation needed).
 */
function stubNetworkController() {
  const stub = {
    async ensure() { return null; },
  } as unknown as NetworkController;
  setNetworkControllerForTests(stub);
}

function makeManager(opts?: { driver?: FakeSandboxDriver; maxSandboxes?: number }) {
  const driver = opts?.driver ?? new FakeSandboxDriver();
  const manager = new SandboxManager({
    driver,
    allocator: new PortAllocator({ min: 47_000, max: 47_099, cooldownMs: 1 }),
    statsIntervalMs: 0,
    skipShutdownHandlers: true,
    maxSandboxes: opts?.maxSandboxes,
  });
  return { manager, driver };
}

const originalBindMount = process.env.MCP_SANDBOX_BIND_MOUNT;
let archiveRoot = '';

beforeEach(() => {
  archiveRoot = mkdtempSync(join(tmpdir(), 'sandbox-archive-authority-'));
  const sessionRoot = join(archiveRoot, 'sessions');
  mkdirSync(sessionRoot, { recursive: true });
  setSandboxArchiveBundleResolver({
    resolveBundle: async (sessionId) => {
      const bundlePath = join(sessionRoot, sessionId);
      mkdirSync(bundlePath, { recursive: true });
      return { sessionRoot, bundlePath };
    },
  });
  setCompanySandboxStore(null);
  setCompanySandboxServicesStore(null);
  setCompanySessionEnvStore(null);
  stubNetworkController();
  // Disable bind-mount persistence so `provision` doesn't try to mkdir
  // host workdirs — the test harness only models container state.
  process.env.MCP_SANDBOX_BIND_MOUNT = '0';
});

afterEach(() => {
  setSandboxArchiveBundleResolver(null);
  rmSync(archiveRoot, { recursive: true, force: true });
  setCompanySandboxStore(null);
  setCompanySandboxServicesStore(null);
  setCompanySessionEnvStore(null);
  setNetworkControllerForTests(null);
  if (originalBindMount === undefined) delete process.env.MCP_SANDBOX_BIND_MOUNT;
  else process.env.MCP_SANDBOX_BIND_MOUNT = originalBindMount;
});

describe('SandboxManager → provision (happy path)', () => {
  it('seeds → creates container → calls scaffolder → marks ready', async () => {
    const scaffolder = new FakeScaffolder('react-ts');
    registerScaffolder(scaffolder);

    const { manager, driver } = makeManager();
    const sb = await manager.provision({ sessionId: sessionId(42), stack: 'react-ts' });

    expect(sb.status).toBe('ready');
    expect(sb.id).toBe(sessionId(42));
    expect(sb.stack).toBe('react-ts');
    expect(sb.containerId).toMatch(/^fake-/);
    expect(driver.calls.create.length).toBe(1);
    expect(scaffolder.calls.length).toBe(1);
    expect(scaffolder.calls[0].sandboxId).toBe(sessionId(42));
    // Phase C removed the `/preview/:id/` proxy — previews are direct
    // loopback URLs to the published host port now (see preview-url.ts).
    expect(scaffolder.calls[0].previewUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
  });

  it('emits provisioning → ready events through the observer', async () => {
    const scaffolder = new FakeScaffolder('react-ts');
    registerScaffolder(scaffolder);

    const { manager } = makeManager();
    const events: Array<{ kind: string; sandboxId?: string }> = [];
    manager.subscribe((ev) => events.push({ kind: ev.kind, sandboxId: (ev as { sandboxId?: string }).sandboxId }));

    await manager.provision({ sessionId: sessionId(43), stack: 'react-ts' });

    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain('provisioning');
    expect(kinds).toContain('ready');
  });

  it('second provision for the same session returns the existing record (idempotent)', async () => {
    const scaffolder = new FakeScaffolder('react-ts');
    registerScaffolder(scaffolder);

    const { manager } = makeManager();
    const first = await manager.provision({ sessionId: sessionId(44), stack: 'react-ts' });
    const second = await manager.provision({ sessionId: sessionId(44), stack: 'react-ts' });

    expect(second.id).toBe(first.id);
    expect(second.containerId).toBe(first.containerId);
    expect(scaffolder.calls.length).toBe(1);
  });
});

describe('SandboxManager → provision (concurrency cap)', () => {
  it('throws when in-use sandboxes ≥ maxSandboxes', async () => {
    const scaffolder = new FakeScaffolder('react-ts');
    registerScaffolder(scaffolder);

    const { manager } = makeManager({ maxSandboxes: 2 });
    await manager.provision({ sessionId: sessionId(50), stack: 'react-ts' });
    await manager.provision({ sessionId: sessionId(51), stack: 'react-ts' });

    await expect(
      manager.provision({ sessionId: sessionId(52), stack: 'react-ts' }),
    ).rejects.toThrow(/Too many concurrent sandboxes/);
  });
});

describe('SandboxManager → provision (error path)', () => {
  it('keeps the record in `error` state (does NOT destroy) when scaffolder throws', async () => {
    class BadScaffolder extends FakeScaffolder {
      async scaffold(): Promise<void> {
        throw new Error('scaffolder boom');
      }
    }
    registerScaffolder(new BadScaffolder('react-ts'));

    const { manager } = makeManager();
    await expect(
      manager.provision({ sessionId: sessionId(60), stack: 'react-ts' }),
    ).rejects.toThrow(/scaffolder boom/);

    // Critical contract: the in-memory record survives so the UI can
    // show context for retry. Earlier behavior wiped it AND freed the
    // port — that's how two sessions collided on the same port.
    const sb = manager.get(sessionId(60));
    expect(sb).toBeDefined();
    expect(sb!.status).toBe('error');
    expect(sb!.error).toContain('scaffolder boom');
  });
});

describe('SandboxManager → provision (retry)', () => {
  it('retry on an errored record tears down + reprovisions cleanly', async () => {
    let throwOnce = true;
    class BadOnceScaffolder extends FakeScaffolder {
      async scaffold(ctx: Parameters<FakeScaffolder['scaffold']>[0]): Promise<void> {
        if (throwOnce) {
          throwOnce = false;
          throw new Error('first attempt fails');
        }
        return super.scaffold(ctx);
      }
    }
    registerScaffolder(new BadOnceScaffolder('react-ts'));

    const { manager } = makeManager();
    await expect(
      manager.provision({ sessionId: sessionId(70), stack: 'react-ts' }),
    ).rejects.toThrow(/first attempt fails/);
    expect(manager.get(sessionId(70))?.status).toBe('error');

    const recovered = await manager.provision({
      sessionId: sessionId(70),
      stack: 'react-ts',
      retry: true,
    });
    expect(recovered.status).toBe('ready');
    expect(recovered.error).toBeUndefined();
  });
});

describe('SandboxManager → provision (scaffolder context)', () => {
  it('passes the manager`s devServerPort + previewPathPrefix into the scaffolder', async () => {
    const scaffolder = new FakeScaffolder('react-ts');
    registerScaffolder(scaffolder);

    const { manager } = makeManager();
    await manager.provision({ sessionId: sessionId(80), stack: 'react-ts' });

    expect(scaffolder.calls[0].devServerPort).toBe(5173);
    // Direct loopback preview → Vite `base` is the bare root.
    expect(scaffolder.calls[0].previewPathPrefix).toBe('/');
  });

  it('forwards `includeE2e` flag from the provision request', async () => {
    const scaffolder = new FakeScaffolder('react-ts');
    registerScaffolder(scaffolder);

    const { manager } = makeManager();
    await manager.provision({
      sessionId: sessionId(81),
      stack: 'react-ts',
      includeE2e: true,
    });

    expect(scaffolder.calls[0].includeE2e).toBe(true);
  });
});
