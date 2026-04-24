import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PortAllocator } from '../core/sandbox/port-allocator.js';
import { SandboxFilesystemAdapter } from '../core/sandbox/adapters/sandbox-filesystem-adapter.js';
import { SandboxShellAdapter } from '../core/sandbox/adapters/sandbox-shell-adapter.js';
import {
  SandboxManager,
  sessionNetworkName,
} from '../core/sandbox/sandbox-manager.js';
import type {
  ISandboxDriver,
  SandboxCreateSpec,
  SandboxExecOptions,
  SandboxExecResult,
  SandboxInspectResult,
  SandboxReaddirEntry,
  SandboxStatsSample,
} from '../core/sandbox/ports/sandbox-driver.js';

/**
 * A minimal in-memory driver mock — zero dependency on Docker/Podman.
 * Exercises the adapter contract without shelling out.
 */
class FakeDriver implements ISandboxDriver {
  readonly runtime = 'docker' as const;
  readonly files = new Map<string, string>();
  readonly dirs = new Set<string>(['/app']);
  readonly calls: string[] = [];

  async create(_: SandboxCreateSpec) {
    return { containerId: 'fake-container' };
  }
  async destroy(_: string) {
    this.calls.push('destroy');
  }
  async exec(_: string, command: string, __: SandboxExecOptions): Promise<SandboxExecResult> {
    this.calls.push(`exec:${command}`);
    return { stdout: `ran ${command}`, stderr: '', exitCode: 0, timedOut: false };
  }
  async run(_: string, program: string, args: string[], __: SandboxExecOptions): Promise<SandboxExecResult> {
    this.calls.push(`run:${program} ${args.join(' ')}`);
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
    return { exists: true, running: true, labels: {} };
  }
  async startContainer(): Promise<void> {
    this.calls.push('startContainer');
  }
  async stopContainer(): Promise<void> {
    this.calls.push('stopContainer');
  }
  async getContainerLogs(): Promise<string> {
    return '';
  }
  async getContainerState(): Promise<null> {
    return null;
  }
}

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
});

describe('multi-service sandbox (migration 035)', () => {
  it('derives deterministic network names per session', () => {
    expect(sessionNetworkName('42')).toBe('mcp-sbx-net-42');
    expect(sessionNetworkName('abc')).toBe('mcp-sbx-net-abc');
    // Disallowed chars get normalized so the name is docker-safe.
    expect(sessionNetworkName('a/b:c')).toBe('mcp-sbx-net-a-b-c');
  });

  it('rejects invalid or reserved service_ids', async () => {
    const driver = new FakeDriver();
    const mgr = new SandboxManager({ driver });
    // Without a primary sandbox provisioned first, the manager must
    // refuse — we can't add a sidecar to nothing.
    await expect(
      mgr.provisionAdditionalService({
        sessionId: '999',
        serviceId: 'main', // reserved
        stack: 'react-ts',
      }),
    ).rejects.toThrow(/reserved/);
    await expect(
      mgr.provisionAdditionalService({
        sessionId: '999',
        serviceId: 'Bad Name', // invalid chars
        stack: 'react-ts',
      }),
    ).rejects.toThrow(/Invalid service_id/);
    // Valid id but no primary in the map yet.
    await expect(
      mgr.provisionAdditionalService({
        sessionId: '999',
        serviceId: 'worker',
        stack: 'react-ts',
      }),
    ).rejects.toThrow(/primary sandbox/);
  });

  it('listServices filters by session prefix', () => {
    const mgr = new SandboxManager({ driver: new FakeDriver() });
    // listServices() is safe to call on an empty manager — returns [].
    expect(mgr.listServices('1')).toEqual([]);
    expect(mgr.getService('1', 'api')).toBeUndefined();
  });
});
