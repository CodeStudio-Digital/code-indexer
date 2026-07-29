import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PortAllocator } from '@mcp/services/sandbox/port-allocator.js';
import { SandboxFilesystemAdapter } from '@mcp/services/sandbox/adapters/sandbox-filesystem-adapter.js';
import { SandboxShellAdapter } from '@mcp/services/sandbox/adapters/sandbox-shell-adapter.js';
import {
  SandboxManager,
  sessionNetworkName,
  setCompanySandboxServicesStore,
  setCompanySandboxStore,
} from '@mcp/services/sandbox/sandbox-manager.js';
import { setDriverForTests } from '@mcp/services/sandbox/drivers/driver-factory.js';
import type {
  ISandboxDriver,
  SandboxCreateSpec,
  SandboxExecOptions,
  SandboxExecResult,
  SandboxInspectResult,
  SandboxReaddirEntry,
  SandboxStatsSample,
} from '@mcp/services/sandbox/ports/sandbox-driver.js';
import type { Sandbox } from '@mcp/services/sandbox/types.js';

const SESSION_ID = '00000000-0000-4000-8000-000000000001';
const OTHER_SESSION_ID = '00000000-0000-4000-8000-000000000999';

/**
 * A minimal in-memory driver mock — zero dependency on Docker/Podman.
 * Exercises the adapter contract without shelling out.
 */
class FakeDriver implements ISandboxDriver {
  readonly runtime = 'docker' as const;
  readonly files = new Map<string, string>();
  readonly dirs = new Set<string>(['/app']);
  readonly calls: string[] = [];
  exists = true;
  running = true;
  paused = false;

  async build() {
    this.calls.push('build');
  }
  async removeImage(tag: string) {
    this.calls.push(`removeImage:${tag}`);
  }
  async create(_: SandboxCreateSpec) {
    return { containerId: 'fake-container' };
  }
  async destroy(_: string) {
    this.calls.push('destroy');
  }
  lastStdin: string | undefined;
  async exec(_: string, command: string, options: SandboxExecOptions): Promise<SandboxExecResult> {
    this.calls.push(`exec:${command}`);
    this.lastStdin = options.stdin;
    return { stdout: `ran ${command}`, stderr: '', exitCode: 0, timedOut: false };
  }
  async run(_: string, program: string, args: string[], options: SandboxExecOptions): Promise<SandboxExecResult> {
    this.calls.push(`run:${program} ${args.join(' ')}`);
    this.lastStdin = options.stdin;
    return { stdout: `ran ${program}`, stderr: '', exitCode: 0, timedOut: false };
  }
  async writeFile(_: string, absPath: string, data: string): Promise<void> {
    this.files.set(absPath, data);
  }
  async readFile(_: string, absPath: string): Promise<string> {
    const v = this.files.get(absPath);
    if (v === undefined) throw new Error(`ENOENT: ${absPath}`);
    return v;
  }
  async mkdir(_: string, absPath: string): Promise<void> {
    this.dirs.add(absPath);
  }
  async access(_: string, absPath: string): Promise<void> {
    if (!this.files.has(absPath) && !this.dirs.has(absPath)) {
      throw new Error(`ENOENT: ${absPath}`);
    }
  }
  async readdir(_: string, absPath: string): Promise<SandboxReaddirEntry[]> {
    const out: SandboxReaddirEntry[] = [];
    for (const path of this.files.keys()) {
      if (path.startsWith(absPath + '/') && path.slice(absPath.length + 1).indexOf('/') === -1) {
        out.push({ name: path.slice(absPath.length + 1), kind: 'file' });
      }
    }
    return out;
  }
  async isPortListening(): Promise<boolean> {
    return true;
  }
  async stats(): Promise<SandboxStatsSample | null> {
    return { cpuPercent: 1.5, memBytes: 10_000_000, sampledAt: Date.now() };
  }
  async exportWorkdir(): Promise<Buffer> {
    // Minimal tar header (empty archive) for the in-memory fake.
    return Buffer.alloc(1024);
  }
  async importWorkdir(): Promise<void> {
    this.calls.push('importWorkdir');
  }
  async inspectContainer(): Promise<SandboxInspectResult> {
    this.calls.push('inspectContainer');
    return { exists: this.exists, running: this.running, paused: this.paused, labels: {} };
  }
  async startContainer(): Promise<void> {
    this.calls.push('startContainer');
  }
  async stopContainer(): Promise<void> {
    this.calls.push('stopContainer');
  }
  async pauseContainer(): Promise<void> {
    this.calls.push('pauseContainer');
    this.paused = true;
  }
  async unpauseContainer(): Promise<void> {
    this.calls.push('unpauseContainer');
    this.paused = false;
  }
  async getContainerLogs(): Promise<string> {
    return '';
  }
  async getContainerState(): Promise<null> {
    return null;
  }
}

function makeSandbox(id: string): Sandbox {
  return {
    id,
    containerId: `${id}-container`,
    runtime: 'docker',
    stack: 'react-ts',
    hostPort: 45_020,
    workdir: '/app',
    containerPort: 5173,
    previewUrl: `/preview/${id}/`,
    limits: { memory: '1g', cpus: '1', pids: 256 },
    status: 'ready',
    runtimePaused: false,
    step: 'ready',
    recentLogs: [],
    createdAt: Date.now(),
    lastAccessAt: Date.now(),
    mountKind: 'owned',
    imageSource: 'default',
  };
}

describe('SandboxManager targeted reconciliation', () => {
  beforeEach(() => {
    setCompanySandboxStore(null);
    setCompanySandboxServicesStore(null);
    setDriverForTests(null);
    delete process.env.MCP_SANDBOX_AUTO_IDLE_REAPER;
  });

  afterEach(() => {
    setCompanySandboxStore(null);
    setCompanySandboxServicesStore(null);
    setDriverForTests(null);
    delete process.env.MCP_SANDBOX_AUTO_IDLE_REAPER;
  });

  it('hydrates only the requested service row without global DB scans or starts', async () => {
    const driver = new FakeDriver();
    setDriverForTests(driver);

    const row = {
      session_id: SESSION_ID,
      service_id: 'api',
      name: 'api',
      container_id: 'api-container',
      runtime: 'docker' as const,
      stack: 'react-ts',
      workdir: '/app',
      host_workdir_mount: null,
      host_port: 45_021,
      limits_json: '{}',
      status: 'running' as const,
      error: null,
      mount_kind: 'external' as const,
      image_source: 'default' as const,
      built_image_tag: null,
      dockerfile_path: null,
      dockerfile_exposed_port: null,
      is_primary: 0 as const,
      last_access_at_ms: 123,
      paused_at_ms: null,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    };
    const serviceStore = {
      get: vi.fn(() => row),
      listBySession: vi.fn(() => {
        throw new Error('listBySession should not be called for a single service');
      }),
      listActive: vi.fn(() => {
        throw new Error('listActive should not be called for a single service');
      }),
      patch: vi.fn(),
    };
    const primaryStore = {
      get: vi.fn(() => null),
      listActive: vi.fn(() => {
        throw new Error('primary listActive should not be called');
      }),
      patch: vi.fn(),
      delete: vi.fn(),
    };
    setCompanySandboxServicesStore(serviceStore as never);
    setCompanySandboxStore(primaryStore as never);

    const mgr = new SandboxManager({ statsIntervalMs: 0 });
    const sb = await mgr.reconcileServiceFromDb(SESSION_ID, 'api');

    expect(sb?.id).toBe(`${SESSION_ID}:api`);
    expect(serviceStore.get).toHaveBeenCalledWith(SESSION_ID, 'api');
    expect(serviceStore.listBySession).not.toHaveBeenCalled();
    expect(serviceStore.listActive).not.toHaveBeenCalled();
    expect(primaryStore.listActive).not.toHaveBeenCalled();
    expect(driver.calls).toEqual(['inspectContainer']);
  });
});

describe('PortAllocator', () => {
  it('hands out unique ports within the pool', async () => {
    // Tiny pool so the test can exhaust it quickly. Each port must be
    // genuinely free (a real bind probe runs), so the range is picked
    // high to avoid collision with other services on dev machines.
    const alloc = new PortAllocator({ min: 45_000, max: 45_004 });
    const a = await alloc.acquire();
    const b = await alloc.acquire();
    expect(a).not.toBe(b);
    expect(a).toBeGreaterThanOrEqual(45_000);
    expect(a).toBeLessThanOrEqual(45_004);
    alloc.release(a);
    alloc.release(b);
  });

  it('throws when the pool is exhausted', async () => {
    const alloc = new PortAllocator({ min: 45_010, max: 45_011, cooldownMs: 0 });
    const p1 = await alloc.acquire();
    const p2 = await alloc.acquire();
    await expect(alloc.acquire()).rejects.toThrow(/no free port/);
    alloc.release(p1);
    alloc.release(p2);
  });
});

describe('SandboxFilesystemAdapter', () => {
  let driver: FakeDriver;
  let fs: SandboxFilesystemAdapter;

  beforeEach(() => {
    driver = new FakeDriver();
    fs = new SandboxFilesystemAdapter({ driver, containerId: 'fake-container' });
  });

  it('routes writeFile/readFile through the driver', async () => {
    await fs.writeFile('/app/src/App.tsx', 'export default () => null;');
    expect(driver.files.get('/app/src/App.tsx')).toBe('export default () => null;');
    const roundtrip = await fs.readFile('/app/src/App.tsx');
    expect(roundtrip).toBe('export default () => null;');
  });

  it('access throws when the path is absent', async () => {
    await expect(fs.access('/app/missing')).rejects.toThrow(/ENOENT/);
    await fs.writeFile('/app/present', 'x');
    await expect(fs.access('/app/present')).resolves.toBeUndefined();
  });

  it('readdir synthesizes Dirent-compatible entries', async () => {
    await fs.writeFile('/app/a.ts', 'x');
    await fs.writeFile('/app/b.ts', 'x');
    const entries = await fs.readdir('/app', { withFileTypes: true });
    expect(entries.map((e) => e.name).sort()).toEqual(['a.ts', 'b.ts']);
    expect(entries[0].isFile()).toBe(true);
    expect(entries[0].isDirectory()).toBe(false);
  });
});

describe('SandboxShellAdapter', () => {
  it('forwards exec with the default cwd when none is supplied', async () => {
    const driver = new FakeDriver();
    const shell = new SandboxShellAdapter({
      driver,
      containerId: 'fake-container',
      defaultCwd: '/app',
    });
    const r = await shell.exec('echo hi', { cwd: '', timeoutMs: 5_000 });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('ran echo hi');
    expect(driver.calls).toContain('exec:echo hi');
  });

  it('forwards run with discrete argv (no shell parsing)', async () => {
    const driver = new FakeDriver();
    const shell = new SandboxShellAdapter({
      driver,
      containerId: 'fake-container',
      defaultCwd: '/app',
    });
    const r = await shell.run('git', ['status', '--short'], { cwd: '/app' });
    expect(r.exitCode).toBe(0);
    expect(driver.calls).toContain('run:git status --short');
  });

  it('forwards stdin through to the driver on exec', async () => {
    const driver = new FakeDriver();
    const shell = new SandboxShellAdapter({
      driver,
      containerId: 'fake-container',
      defaultCwd: '/app',
    });
    await shell.exec('python -', {
      cwd: '/app',
      timeoutMs: 5_000,
      stdin: "print('hi')",
    });
    expect(driver.lastStdin).toBe("print('hi')");
  });

  it('omits stdin when none is supplied', async () => {
    const driver = new FakeDriver();
    const shell = new SandboxShellAdapter({
      driver,
      containerId: 'fake-container',
      defaultCwd: '/app',
    });
    await shell.exec('echo hi', { cwd: '/app', timeoutMs: 5_000 });
    expect(driver.lastStdin).toBeUndefined();
  });
});

describe('multi-service sandbox (migration 035)', () => {
  it('derives deterministic network names per session', () => {
    expect(sessionNetworkName(SESSION_ID)).toBe(`mcp-sbx-net-${SESSION_ID}`);
    expect(() => sessionNetworkName('42')).toThrow(/canonical UUID/);
  });

  it('rejects invalid or reserved service_ids', async () => {
    const driver = new FakeDriver();
    const mgr = new SandboxManager({ driver });
    await expect(
      mgr.provisionAdditionalService({
        sessionId: OTHER_SESSION_ID,
        serviceId: 'main', // reserved
        stack: 'react-ts',
      }),
    ).rejects.toThrow(/reserved/);
    await expect(
      mgr.provisionAdditionalService({
        sessionId: OTHER_SESSION_ID,
        serviceId: 'Bad Name', // invalid chars
        stack: 'react-ts',
      }),
    ).rejects.toThrow(/Invalid service_id/);
  });

  it('listServices filters by session prefix', () => {
    const mgr = new SandboxManager({ driver: new FakeDriver() });
    // listServices() is safe to call on an empty manager — returns [].
    expect(mgr.listServices(SESSION_ID)).toEqual([]);
    expect(mgr.getService(SESSION_ID, 'api')).toBeUndefined();
  });

  it('runtime-pauses and unpauses the primary container without stopping it', async () => {
    const driver = new FakeDriver();
    const mgr = new SandboxManager({ driver, statsIntervalMs: 0 });
    const sb = makeSandbox(SESSION_ID);
    (mgr as unknown as { sandboxes: Map<string, Sandbox> }).sandboxes.set(SESSION_ID, sb);

    await mgr.pauseRuntimeContainer(SESSION_ID, 'main');
    expect(driver.calls).toContain('pauseContainer');
    expect(sb.runtimePaused).toBe(true);
    expect(sb.status).toBe('ready');

    await mgr.unpauseRuntimeContainer(SESSION_ID, 'main');
    expect(driver.calls).toContain('unpauseContainer');
    expect(sb.runtimePaused).toBe(false);
    expect(sb.status).toBe('ready');
  });

  it('runtime-pauses and unpauses a secondary service container', async () => {
    const driver = new FakeDriver();
    const mgr = new SandboxManager({ driver, statsIntervalMs: 0 });
    const serviceKey = `${SESSION_ID}:api`;
    const sb = makeSandbox(serviceKey);
    (mgr as unknown as { services: Map<string, Sandbox> }).services.set(serviceKey, sb);

    await mgr.pauseRuntimeContainer(SESSION_ID, 'api');
    expect(driver.calls).toContain('pauseContainer');
    expect(sb.runtimePaused).toBe(true);

    await mgr.unpauseRuntimeContainer(SESSION_ID, 'api');
    expect(driver.calls).toContain('unpauseContainer');
    expect(sb.runtimePaused).toBe(false);
  });

  it('treats an already runtime-paused container as an idempotent pause', async () => {
    const driver = new FakeDriver();
    driver.paused = true;
    const mgr = new SandboxManager({ driver, statsIntervalMs: 0 });
    const sb = makeSandbox(SESSION_ID);
    (mgr as unknown as { sandboxes: Map<string, Sandbox> }).sandboxes.set(SESSION_ID, sb);

    await mgr.pauseRuntimeContainer(SESSION_ID, 'main');
    expect(driver.calls).not.toContain('pauseContainer');
    expect(sb.runtimePaused).toBe(true);
    expect(sb.status).toBe('ready');
  });

  it('rejects runtime pause when the container no longer exists', async () => {
    const driver = new FakeDriver();
    driver.exists = false;
    const mgr = new SandboxManager({ driver, statsIntervalMs: 0 });
    const sb = makeSandbox(SESSION_ID);
    (mgr as unknown as { sandboxes: Map<string, Sandbox> }).sandboxes.set(SESSION_ID, sb);

    await expect(mgr.pauseRuntimeContainer(SESSION_ID, 'main')).rejects.toThrow(/no longer exists/);
    expect(sb.runtimePaused).toBe(false);
  });
});
