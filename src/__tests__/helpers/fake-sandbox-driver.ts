/**
 * In-memory fake ISandboxDriver for sandbox-manager integration tests.
 *
 * Goals:
 *   - Zero network / filesystem / podman dependency — pure JS state.
 *   - Honors the driver contract (containers must exist after create,
 *     destroyed containers vanish, idempotent stop/pause, etc.) so the
 *     manager paths exercise the same branches they would in production.
 *   - Records every call so assertions can verify the manager talks to
 *     the driver in the expected shape (which env vars were written,
 *     what port was probed, etc.).
 *
 * NOT a substitute for real-driver acceptance tests. Use this for
 * "did the manager wire it up correctly" — never for "does the driver
 * implement the API correctly".
 */
import type {
  ISandboxDriver,
  SandboxBuildSpec,
  SandboxCreateSpec,
  SandboxExecOptions,
  SandboxExecResult,
  SandboxInspectResult,
  SandboxReaddirEntry,
  SandboxStateSnapshot,
  SandboxStatsSample,
} from '@mcp/services/sandbox/ports/sandbox-driver.js';

export interface FakeContainerState {
  id: string;
  image: string;
  running: boolean;
  paused: boolean;
  labels: Record<string, string>;
  env: Record<string, string>;
  /** Container-side filesystem (path → utf-8 content). */
  files: Map<string, string>;
  /** Directories created via `mkdir`. */
  dirs: Set<string>;
  hostPort: number;
  containerPort: number;
  workdir: string;
  createdAt: number;
}

export interface DriverCallLog {
  build: SandboxBuildSpec[];
  removeImage: string[];
  create: SandboxCreateSpec[];
  destroy: string[];
  startContainer: string[];
  stopContainer: Array<{ id: string; graceSeconds?: number }>;
  pauseContainer: string[];
  unpauseContainer: string[];
  exec: Array<{ id: string; command: string; options: SandboxExecOptions }>;
  run: Array<{ id: string; program: string; args: string[]; options: SandboxExecOptions }>;
  writeFile: Array<{ id: string; path: string; data: string }>;
  readFile: Array<{ id: string; path: string }>;
  mkdir: Array<{ id: string; path: string; recursive: boolean }>;
  isPortListening: number[];
}

export interface FakeDriverOptions {
  /** When set, isPortListening returns true only for ports in this set. Default: any port that any container exposes. */
  portsListening?: number[] | 'auto';
  /** Override exec output for matching command substrings. */
  execOverrides?: Array<{ match: RegExp | string; result: Partial<SandboxExecResult> }>;
}

export class FakeSandboxDriver implements ISandboxDriver {
  readonly runtime = 'docker' as const;
  readonly containers = new Map<string, FakeContainerState>();
  readonly images = new Set<string>();
  readonly calls: DriverCallLog = {
    build: [],
    removeImage: [],
    create: [],
    destroy: [],
    startContainer: [],
    stopContainer: [],
    pauseContainer: [],
    unpauseContainer: [],
    exec: [],
    run: [],
    writeFile: [],
    readFile: [],
    mkdir: [],
    isPortListening: [],
  };
  private nextContainerId = 1;
  private readonly opts: FakeDriverOptions;

  constructor(opts: FakeDriverOptions = {}) {
    this.opts = opts;
  }

  /**
   * Test helper — register a pre-existing container without going
   * through `create()`. Use this to simulate `podman run` happening
   * outside the manager (the attach flow).
   */
  seedContainer(
    id: string,
    overrides: Partial<FakeContainerState> = {},
  ): FakeContainerState {
    const state: FakeContainerState = {
      id,
      image: 'mcp-sandbox-node:20',
      running: true,
      paused: false,
      labels: {},
      env: {},
      files: new Map(),
      dirs: new Set(),
      hostPort: 0,
      containerPort: 5173,
      workdir: '/app',
      createdAt: Date.now(),
      ...overrides,
    };
    this.containers.set(id, state);
    return state;
  }

  async build(spec: SandboxBuildSpec): Promise<void> {
    this.calls.build.push(spec);
    this.images.add(spec.imageTag);
  }

  async removeImage(tag: string): Promise<void> {
    this.calls.removeImage.push(tag);
    this.images.delete(tag);
  }

  async create(spec: SandboxCreateSpec): Promise<{ containerId: string }> {
    this.calls.create.push(spec);
    const id = `fake-${this.nextContainerId++}`;
    this.containers.set(id, {
      id,
      image: spec.image,
      running: true,
      paused: false,
      labels: { 'mcp.sandbox-id': spec.sandboxId },
      env: { ...(spec.env ?? {}) },
      files: new Map(),
      dirs: new Set(),
      hostPort: spec.hostPort,
      containerPort: spec.containerPort,
      workdir: spec.workdir,
      createdAt: Date.now(),
    });
    return { containerId: id };
  }

  async destroy(containerId: string): Promise<void> {
    this.calls.destroy.push(containerId);
    this.containers.delete(containerId);
  }

  async inspectContainer(containerId: string): Promise<SandboxInspectResult> {
    const c = this.containers.get(containerId);
    if (!c) return { exists: false, running: false, paused: false, labels: {} };
    return { exists: true, running: c.running, paused: c.paused, labels: c.labels };
  }

  async startContainer(containerId: string): Promise<void> {
    this.calls.startContainer.push(containerId);
    const c = this.containers.get(containerId);
    if (c) { c.running = true; c.paused = false; }
  }

  async stopContainer(containerId: string, graceSeconds?: number): Promise<void> {
    this.calls.stopContainer.push({ id: containerId, graceSeconds });
    const c = this.containers.get(containerId);
    if (c) c.running = false;
  }

  async pauseContainer(containerId: string): Promise<void> {
    this.calls.pauseContainer.push(containerId);
    const c = this.containers.get(containerId);
    if (c && c.running) c.paused = true;
  }

  async unpauseContainer(containerId: string): Promise<void> {
    this.calls.unpauseContainer.push(containerId);
    const c = this.containers.get(containerId);
    if (c) c.paused = false;
  }

  async exec(
    containerId: string,
    command: string,
    options: SandboxExecOptions,
  ): Promise<SandboxExecResult> {
    this.calls.exec.push({ id: containerId, command, options });
    for (const ov of this.opts.execOverrides ?? []) {
      const m = typeof ov.match === 'string' ? command.includes(ov.match) : ov.match.test(command);
      if (m) {
        return {
          stdout: ov.result.stdout ?? '',
          stderr: ov.result.stderr ?? '',
          exitCode: ov.result.exitCode ?? 0,
          timedOut: ov.result.timedOut ?? false,
        };
      }
    }
    return { stdout: '', stderr: '', exitCode: 0, timedOut: false };
  }

  async run(
    containerId: string,
    program: string,
    args: string[],
    options: SandboxExecOptions,
  ): Promise<SandboxExecResult> {
    this.calls.run.push({ id: containerId, program, args, options });
    return { stdout: '', stderr: '', exitCode: 0, timedOut: false };
  }

  async writeFile(
    containerId: string,
    absPath: string,
    data: string,
    _options?: { recursive?: boolean },
  ): Promise<void> {
    this.calls.writeFile.push({ id: containerId, path: absPath, data });
    const c = this.containers.get(containerId);
    if (c) c.files.set(absPath, data);
  }

  async readFile(containerId: string, absPath: string): Promise<string> {
    this.calls.readFile.push({ id: containerId, path: absPath });
    const c = this.containers.get(containerId);
    if (!c) throw new Error(`fake driver: container ${containerId} not found`);
    const data = c.files.get(absPath);
    if (data === undefined) throw new Error(`fake driver: file ${absPath} not found`);
    return data;
  }

  async mkdir(
    containerId: string,
    absPath: string,
    options?: { recursive?: boolean },
  ): Promise<void> {
    this.calls.mkdir.push({ id: containerId, path: absPath, recursive: !!options?.recursive });
    const c = this.containers.get(containerId);
    if (c) c.dirs.add(absPath);
  }

  async access(containerId: string, absPath: string): Promise<void> {
    const c = this.containers.get(containerId);
    if (!c) throw new Error(`fake driver: container ${containerId} not found`);
    if (!c.files.has(absPath) && !c.dirs.has(absPath)) {
      throw new Error(`fake driver: ${absPath} does not exist`);
    }
  }

  async readdir(containerId: string, absPath: string): Promise<SandboxReaddirEntry[]> {
    const c = this.containers.get(containerId);
    if (!c) return [];
    const out: SandboxReaddirEntry[] = [];
    const prefix = absPath.endsWith('/') ? absPath : `${absPath}/`;
    for (const f of c.files.keys()) {
      if (f.startsWith(prefix) && !f.slice(prefix.length).includes('/')) {
        out.push({ name: f.slice(prefix.length), kind: 'file' });
      }
    }
    for (const d of c.dirs) {
      if (d.startsWith(prefix) && !d.slice(prefix.length).includes('/')) {
        out.push({ name: d.slice(prefix.length), kind: 'dir' });
      }
    }
    return out;
  }

  async isPortListening(hostPort: number): Promise<boolean> {
    this.calls.isPortListening.push(hostPort);
    if (this.opts.portsListening === undefined || this.opts.portsListening === 'auto') {
      for (const c of this.containers.values()) {
        if (c.hostPort === hostPort && c.running && !c.paused) return true;
      }
      return false;
    }
    return this.opts.portsListening.includes(hostPort);
  }

  async stats(containerId: string): Promise<SandboxStatsSample | null> {
    const c = this.containers.get(containerId);
    if (!c || !c.running || c.paused) return null;
    return { cpuPercent: 0.5, memBytes: 64 * 1024 * 1024, sampledAt: Date.now() };
  }

  async exportWorkdir(containerId: string, _workdir: string): Promise<Buffer> {
    const c = this.containers.get(containerId);
    if (!c) throw new Error('not found');
    const json = JSON.stringify(Array.from(c.files.entries()));
    return Buffer.from(json, 'utf8');
  }

  async importWorkdir(containerId: string, _workdir: string, tar: Buffer): Promise<void> {
    const c = this.containers.get(containerId);
    if (!c) return;
    const entries = JSON.parse(tar.toString('utf8')) as Array<[string, string]>;
    for (const [p, d] of entries) c.files.set(p, d);
  }

  async getContainerLogs(containerId: string, _tail?: number): Promise<string> {
    return this.containers.has(containerId) ? `fake logs for ${containerId}` : '';
  }

  async getContainerState(containerId: string): Promise<SandboxStateSnapshot | null> {
    const c = this.containers.get(containerId);
    if (!c) return null;
    return {
      exitCode: c.running ? null : 0,
      oomKilled: false,
      error: '',
      startedAt: new Date(c.createdAt).toISOString(),
      finishedAt: c.running ? '' : new Date().toISOString(),
    };
  }
}
