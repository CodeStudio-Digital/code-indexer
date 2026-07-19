/**
 * CLI-based OCI driver — shared implementation for any runtime that ships
 * a Docker-compatible command-line interface (Docker, Podman, nerdctl).
 *
 * Design note (deliberate deviation from the plan):
 *   The original plan called for `dockerode` against a configurable socket.
 *   We chose the CLI path instead because:
 *     1. Zero new dependencies (no native binding, no HTTP-over-unix-socket
 *        plumbing). `IShellPort` already knows how to spawn processes.
 *     2. Identical interface across Docker Desktop (Windows/macOS/Linux)
 *        and Podman (including rootless). Both ship compatible CLIs.
 *     3. Trivial to unit-test: inject a mock `IShellPort` and assert on
 *        the argv, no Docker daemon required in CI.
 *     4. The per-call `spawn` overhead (~10ms) is irrelevant at LLM pacing
 *        (human-scale edits, not per-request throughput).
 *
 * Runtime-specific behavior (socket paths, rootless flags, image name
 * aliases) lives in subclasses — this base only encodes the shared
 * command shape: `<binary> <subcommand> ...args`.
 *
 * File transfer strategy:
 *   - `writeFile`  → `<binary> cp` from a host temp file into the
 *     container. Atomic, handles arbitrary binary bytes, no shell quoting.
 *   - `readFile`   → `<binary> cp` from the container to stdout (via
 *     `-` destination) read into memory.
 *   - `mkdir` / `access` / `readdir` → cheap `exec` calls with small
 *     argv. No shell parsing — uses the argv form of `exec`.
 */

import { mkdtemp, rm, writeFile as hostWriteFile, readFile as hostReadFile } from 'node:fs/promises';
import {
  parseMemBytes,
  parsePercent,
  sanitizeContainerName,
} from './cli-oci/helpers.js';
import { spawn as spawnChild } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { trackProcessTree } from '@mcp/shared/utils/process-tree.js';
import type { IShellPort, ShellExecResult } from '@mcp/code-agent/ports/shell-port.js';
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
} from '../ports/sandbox-driver.js';

export interface CliOciDriverOptions {
  /** Executable name or path — `docker`, `podman`, or an absolute path. */
  binary: string;
  /** Runtime identifier recorded on `Sandbox.runtime`. */
  runtime: 'docker' | 'podman';
  /** Shell port used to spawn the CLI. Injected for testability. */
  shell: IShellPort;
  /**
   * Extra argv prepended to every subcommand. Subclasses use this for
   * runtime-specific flags (e.g. Podman rootless may need `--remote`).
   */
  globalArgs?: string[];
  /**
   * Optional `cwd` for CLI invocations. Defaults to the process cwd.
   * Harmless but pinned for reproducibility.
   */
  cwd?: string;
  /** Default timeout for inline management commands (create, destroy, cp, small exec). */
  defaultTimeoutMs?: number;
}

// Generous default — Docker Desktop on Windows/macOS can take well over a
// minute to cold-start a container after the host wakes from sleep. The
// pre-async shell path effectively had an infinite timeout; 120s is the
// conservative "do no harm" equivalent now that SIGKILL is enforced.
const DEFAULT_MGMT_TIMEOUT_MS = 120_000;

export class CliOciDriver implements ISandboxDriver {
  readonly runtime: 'docker' | 'podman';
  protected readonly binary: string;
  protected readonly shell: IShellPort;
  protected readonly globalArgs: string[];
  protected readonly cwd: string;
  protected readonly defaultTimeoutMs: number;

  constructor(options: CliOciDriverOptions) {
    this.binary = options.binary;
    this.runtime = options.runtime;
    this.shell = options.shell;
    this.globalArgs = options.globalArgs ?? [];
    this.cwd = options.cwd ?? process.cwd();
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_MGMT_TIMEOUT_MS;
  }

  // ───────────────────────────────────────────────────────────── lifecycle

  async build(spec: SandboxBuildSpec): Promise<void> {
    const args = [
      ...this.globalArgs,
      'build',
      '-t',
      spec.imageTag,
      '-f',
      spec.dockerfilePath,
      ...(spec.noCache ? ['--no-cache'] : []),
      spec.contextDir,
    ];

    await new Promise<void>((resolve, reject) => {
      const child = spawnChild(this.binary, args, {
        cwd: this.cwd,
        env: process.env,
        windowsHide: true,
        detached: process.platform !== 'win32',
      });
      const untrack = trackProcessTree(child.pid);
      const onAbort = () => {
        // Abort is latency-sensitive and already owns the ChildProcess handle.
        // Full tree cleanup remains part of the owning runtime shutdown.
        try { child.kill('SIGKILL'); } catch { /* already exited */ }
      };
      spec.signal?.addEventListener('abort', onAbort, { once: true });
      child.stdout?.setEncoding('utf8');
      child.stderr?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => spec.emit?.({ stream: 'stdout', chunk }));
      child.stderr?.on('data', (chunk: string) => spec.emit?.({ stream: 'stderr', chunk }));
      child.once('error', (err) => {
        untrack();
        spec.signal?.removeEventListener('abort', onAbort);
        reject(err);
      });
      child.once('close', (code) => {
        untrack();
        spec.signal?.removeEventListener('abort', onAbort);
        if (spec.signal?.aborted) {
          reject(new Error(`${this.binary} build aborted`));
          return;
        }
        if (code === 0) {
          resolve();
          return;
        }
        reject(new Error(`${this.binary} build failed with exit code ${code ?? 'null'}`));
      });
    });
  }

  async removeImage(tag: string): Promise<void> {
    if (!tag.trim()) return;
    await this.cli([...this.globalArgs, 'rmi', '-f', tag], {
      timeoutMs: this.defaultTimeoutMs,
    }).catch(() => void 0);
  }

  async create(spec: SandboxCreateSpec): Promise<{ containerId: string }> {
    // Pre-flight cleanup: remove any lingering container with the name
    // we're about to use. This handles three crash scenarios:
    //   1. Previous provision succeeded to `run` but failed later (e.g.
    //      scaffolder, prepareWorkdir) — our catch block destroys by
    //      containerId, but if THAT destroy raced or silently failed,
    //      the named container survives.
    //   2. API server crashed/restarted between provisions — the
    //      in-memory sandbox record is gone but Podman/Docker still
    //      holds the container.
    //   3. Operator manually created a container with our naming
    //      pattern — rare, but `rm -f` is idempotent and safe.
    //
    // We tolerate errors: "No such container" is the expected exit
    // code for a clean slate, and any other failure surfaces later
    // when the subsequent `run` can't grab the name either.
    const name = sanitizeContainerName(spec.sandboxId);
    await this.shell.run(this.binary, [...this.globalArgs, 'rm', '-f', name], {
      cwd: this.cwd,
      encoding: 'utf-8',
    }).catch(() => void 0);

    const args = [
      ...this.globalArgs,
      'run',
      '-d',
      // Default: bind loopback only — the API proxy is what exposes
      // sandboxes to the outside world, with auth and path rewriting.
      // Binding on 0.0.0.0 would silently bypass the proxy.
      //
      // Override (`spec.hostBindAddr === '0.0.0.0'`) is for shared
      // infra containers (e.g. the Chrome Service singleton). Other
      // containers reach those via `host.containers.internal`, which
      // resolves to the network gateway IP — that gateway can only
      // route to ports bound on 0.0.0.0, NOT 127.0.0.1.
      '-p', `${spec.hostBindAddr ?? '127.0.0.1'}:${spec.hostPort}:${spec.containerPort}`,
      // Traceable label — reaper uses this on boot to remove orphaned
      // containers left behind by a crashed API process.
      '--label', `mcp.sandbox=1`,
      '--label', `mcp.sessionId=${spec.sandboxId}`,
      '--label', `mcp.stack=${spec.stack}`,
      // Workdir label so the orphan reaper on a subsequent API boot
      // can locate + export this container's files before destroying
      // it. Without this, after a hard server crash we'd know which
      // containers to sweep (via mcp.sandbox=1) but not which path
      // inside each one holds the user's work.
      '--label', `mcp.workdir=${spec.workdir}`,
      `--name`, sanitizeContainerName(spec.sandboxId),
      // Persistence: bind-mount a host dir onto the workdir so files
      // survive container destruction. Node_modules lives in a named
      // volume to keep bind-mount I/O fast on Docker Desktop and keep
      // linux binaries out of the host tree. See persistence plan.
      ...(spec.hostWorkdirMount
        ? ['-v', `${spec.hostWorkdirMount}:${spec.workdir}`]
        : []),
      ...(spec.hostWorkdirMount && spec.nodeModulesVolumeName
        ? ['-v', `${spec.nodeModulesVolumeName}:${spec.workdir}/node_modules`]
        : []),
      // Deliberately NOT passing `-w <workdir>` on `run`.
      //
      // Podman (≥4.x) validates that the workdir already exists in the
      // image at run-time and refuses to start the container otherwise,
      // emitting `Error: workdir "/app" does not exist on container …`.
      // Docker is permissive and auto-creates, but we can't rely on
      // that.
      //
      // Instead, we let the image's Dockerfile `WORKDIR` directive set
      // the default cwd (which DOES survive the Podman check because it
      // runs during `build`, not `run`), and we pass an explicit
      // `-w <workdir>` on every subsequent `exec`, where the flag's
      // semantics are "cd before running the command" — no existence
      // check. `SandboxManager.prepareWorkdir` runs a root-owned
      // mkdir+chown right after create, which also covers images that
      // were built without WORKDIR /app or with a different layout.
      '--memory', spec.limits.memory,
      '--cpus', spec.limits.cpus,
      '--pids-limit', String(spec.limits.pids),
      // Keep stdin open so `<binary> cp` and long-running scaffolders have
      // a stable attach point.
      '-i',
    ];

    // Isolation flags. These are additive — each defaults to a safer
    // value in `DEFAULT_SANDBOX_ISOLATION` but can be relaxed per-spec.
    if (spec.isolation.user) {
      args.push('--user', spec.isolation.user);
    }
    if (spec.isolation.dropAllCaps) {
      args.push('--cap-drop', 'ALL');
    }
    if (spec.isolation.noNewPrivs) {
      args.push('--security-opt', 'no-new-privileges:true');
    }
    if (spec.isolation.readOnlyRoot) {
      // `--read-only` makes `/` read-only; we provide a small tmpfs for
      // `/tmp` so scaffolders and `npm` can write ephemerals. `/app` is
      // a regular bind (writable) from the container's perspective.
      args.push('--read-only', '--tmpfs', '/tmp:rw,noexec,nosuid,size=128m');
    }
    if (spec.isolation.seccompProfile) {
      // Accepts an absolute path to a JSON profile OR the sentinel
      // 'unconfined'. Docker/Podman both understand both forms.
      args.push('--security-opt', `seccomp=${spec.isolation.seccompProfile}`);
    }
    if (spec.isolation.network) {
      // Join a named network (must already exist). The egress firewall
      // (phase 6b) creates `mcp-sandbox-net` at startup; operators can
      // point at any other network name via env.
      args.push('--network', spec.isolation.network);
    }
    // HTTP proxy plumbing — npm / curl / fetch inside the container pick
    // this up automatically. Merged with caller-provided env below so an
    // explicit `HTTP_PROXY` in `spec.env` wins.
    const proxyEnv: Record<string, string> = {};
    if (spec.isolation.httpProxy) {
      proxyEnv.HTTP_PROXY = spec.isolation.httpProxy;
      proxyEnv.HTTPS_PROXY = spec.isolation.httpProxy;
      proxyEnv.http_proxy = spec.isolation.httpProxy;
      proxyEnv.https_proxy = spec.isolation.httpProxy;
      // Keep loopback + the container-local dev server off the proxy.
      proxyEnv.NO_PROXY = 'localhost,127.0.0.1,::1';
    }
    const mergedEnv = { ...proxyEnv, ...(spec.env ?? {}) };
    for (const [k, v] of Object.entries(mergedEnv)) {
      args.push('-e', `${k}=${v}`);
    }
    // Per-session raw run flags (e.g. --cpuset-cpus). Inserted last, right
    // before the image, so a session can override earlier defaults.
    if (spec.runArgs?.length) {
      args.push(...spec.runArgs);
    }
    if (spec.skipDefaultCommand) {
      args.push(spec.image);
    } else {
      // Give the container SOMETHING to do so `-d` doesn't immediately exit.
      // `sleep infinity` is supported by GNU coreutils (our alpine image ships
      // busybox, so we use `tail -f /dev/null` which is universal).
      args.push(spec.image, 'tail', '-f', '/dev/null');
    }

    const res = await this.cli(args, { timeoutMs: this.defaultTimeoutMs });
    if (res.exitCode !== 0) {
      throw new Error(
        `${this.binary} run failed (exit ${res.exitCode}): ${res.stderr.trim() || res.stdout.trim()}`,
      );
    }
    const containerId = res.stdout.trim().split('\n').pop() ?? '';
    if (!containerId) throw new Error(`${this.binary} run returned empty container id`);
    return { containerId };
  }

  async destroy(containerId: string): Promise<void> {
    // -f implies SIGKILL if the main process doesn't exit on SIGTERM.
    // We ignore non-zero exits: missing containers are not an error at
    // destroy time (idempotency).
    await this.cli([...this.globalArgs, 'rm', '-f', containerId], {
      timeoutMs: this.defaultTimeoutMs,
    });
  }

  async inspectContainer(containerId: string): Promise<SandboxInspectResult> {
    // `inspect --format` returns JSON we can parse for exactly the
    // booleans the manager cares about (exists, running, paused) plus labels
    // so the reconcile path can read `mcp.workdir` / `mcp.sessionId`
    // without a second call. Exit code non-zero = container gone.
    const res = await this.cli(
      [
        ...this.globalArgs,
        'inspect',
        '--format',
        '{{json .State.Running}}|{{json .State.Paused}}|{{json .Config.Labels}}',
        containerId,
      ],
      { timeoutMs: this.defaultTimeoutMs },
    );
    this.throwIfTimedOut(res, 'inspect');
    if (res.exitCode !== 0) {
      return { exists: false, running: false, paused: false, labels: {} };
    }
    const [runningRaw, pausedRaw, labelsRaw] = res.stdout.trim().split('|');
    let running = false;
    let paused = false;
    let labels: Record<string, string> = {};
    try {
      running = JSON.parse(runningRaw ?? 'false') === true;
    } catch {
      /* leave false */
    }
    try {
      paused = JSON.parse(pausedRaw ?? 'false') === true;
    } catch {
      /* leave false */
    }
    try {
      const parsed = JSON.parse(labelsRaw ?? '{}');
      // `Config.Labels` can be `null` when a container has no labels
      // (shouldn't happen for ours, but guard for safety).
      if (parsed && typeof parsed === 'object') labels = parsed as Record<string, string>;
    } catch {
      /* leave {} */
    }
    return { exists: true, running, paused, labels };
  }

  async startContainer(containerId: string): Promise<void> {
    const res = await this.cli([...this.globalArgs, 'start', containerId], {
      timeoutMs: this.defaultTimeoutMs,
    });
    this.throwIfTimedOut(res, 'start');
    if (res.exitCode !== 0) {
      // "already started" is acceptable; other failures propagate.
      const stderr = res.stderr.toLowerCase();
      if (stderr.includes('already') && stderr.includes('running')) return;
      throw new Error(`${this.binary} start failed: ${res.stderr.trim() || res.stdout.trim()}`);
    }
  }

  async stopContainer(containerId: string, graceSeconds = 10): Promise<void> {
    // `stop -t N` sends SIGTERM, waits up to N seconds, then SIGKILL.
    // Unlike `rm -f`, the container survives with its filesystem intact —
    // a subsequent `start` resumes from the image+layers without a
    // fresh scaffold.
    const res = await this.cli(
      [...this.globalArgs, 'stop', '-t', String(graceSeconds), containerId],
      { timeoutMs: (graceSeconds + 5) * 1_000 },
    );
    this.throwIfTimedOut(res, 'stop');
    if (res.exitCode !== 0) {
      const stderr = res.stderr.toLowerCase();
      // "already stopped" and "no such container" are both success
      // from the caller's perspective.
      if (stderr.includes('no such') || stderr.includes('not running')) return;
      throw new Error(`${this.binary} stop failed: ${res.stderr.trim() || res.stdout.trim()}`);
    }
  }

  async pauseContainer(containerId: string): Promise<void> {
    const res = await this.cli([...this.globalArgs, 'pause', containerId], {
      timeoutMs: this.defaultTimeoutMs,
    });
    this.throwIfTimedOut(res, 'pause');
    if (res.exitCode !== 0) {
      const text = `${res.stderr}\n${res.stdout}`.toLowerCase();
      if (text.includes('already') && text.includes('paused')) return;
      if (text.includes('is paused')) return;
      throw new Error(`${this.binary} pause failed: ${res.stderr.trim() || res.stdout.trim()}`);
    }
  }

  async unpauseContainer(containerId: string): Promise<void> {
    const res = await this.cli([...this.globalArgs, 'unpause', containerId], {
      timeoutMs: this.defaultTimeoutMs,
    });
    this.throwIfTimedOut(res, 'unpause');
    if (res.exitCode !== 0) {
      const text = `${res.stderr}\n${res.stdout}`.toLowerCase();
      if (text.includes('not paused') || text.includes('is not paused')) return;
      throw new Error(`${this.binary} unpause failed: ${res.stderr.trim() || res.stdout.trim()}`);
    }
  }

  // ─────────────────────────────────────────────────────────────── exec

  async exec(
    containerId: string,
    command: string,
    options: SandboxExecOptions,
  ): Promise<SandboxExecResult> {
    const argv = [...this.globalArgs, 'exec'];
    // `-i` is required when we have a payload to pipe; without it the
    // CLI closes the child's stdin immediately and the script never
    // sees the bytes.
    if (options.stdin !== undefined) argv.push('-i');
    if (options.cwd) argv.push('-w', options.cwd);
    if (options.user) argv.push('--user', options.user);
    if (options.env) {
      for (const [k, v] of Object.entries(options.env)) {
        argv.push('-e', `${k}=${v}`);
      }
    }
    argv.push(containerId, 'sh', '-c', command);
    return this.toSandboxResult(await this.cli(argv, options));
  }

  async run(
    containerId: string,
    program: string,
    args: string[],
    options: SandboxExecOptions,
  ): Promise<SandboxExecResult> {
    const argv = [...this.globalArgs, 'exec'];
    if (options.stdin !== undefined) argv.push('-i');
    if (options.cwd) argv.push('-w', options.cwd);
    if (options.user) argv.push('--user', options.user);
    if (options.env) {
      for (const [k, v] of Object.entries(options.env)) {
        argv.push('-e', `${k}=${v}`);
      }
    }
    argv.push(containerId, program, ...args);
    return this.toSandboxResult(await this.cli(argv, options));
  }

  // ─────────────────────────────────────────────────────────── filesystem

  async writeFile(
    containerId: string,
    absPath: string,
    data: string,
    options?: { recursive?: boolean },
  ): Promise<void> {
    // Stage the content on the host, then `docker cp` into the container.
    // `cp` is atomic and does not go through `sh`, so no quoting concerns.
    const staging = await mkdtemp(join(tmpdir(), 'mcp-sbx-'));
    const hostFile = join(staging, 'payload');
    try {
      await hostWriteFile(hostFile, data, 'utf-8');
      if (options?.recursive) {
        await this.ensureParentDir(containerId, absPath);
      }
      const res = await this.cli(
        [...this.globalArgs, 'cp', hostFile, `${containerId}:${absPath}`],
        { timeoutMs: this.defaultTimeoutMs },
      );
      if (res.exitCode !== 0) {
        throw new Error(`${this.binary} cp failed: ${res.stderr.trim() || res.stdout.trim()}`);
      }
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }

  async readFile(containerId: string, absPath: string): Promise<string> {
    // `<binary> cp <id>:<path> -` streams the file to stdout as a tar
    // archive. To keep this dependency-free we prefer the simpler route:
    // stage into a host temp file with `cp` then read it.
    const staging = await mkdtemp(join(tmpdir(), 'mcp-sbx-'));
    const hostFile = join(staging, 'payload');
    try {
      const res = await this.cli(
        [...this.globalArgs, 'cp', `${containerId}:${absPath}`, hostFile],
        { timeoutMs: this.defaultTimeoutMs },
      );
      if (res.exitCode !== 0) {
        throw new Error(
          `${this.binary} cp ${absPath} failed: ${res.stderr.trim() || res.stdout.trim()}`,
        );
      }
      return await hostReadFile(hostFile, 'utf-8');
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }

  async mkdir(
    containerId: string,
    absPath: string,
    options?: { recursive?: boolean },
  ): Promise<void> {
    const args = ['mkdir'];
    if (options?.recursive) args.push('-p');
    args.push(absPath);
    const res = await this.run(containerId, args[0], args.slice(1), {
      timeoutMs: this.defaultTimeoutMs,
    });
    if (res.exitCode !== 0 && !options?.recursive) {
      throw new Error(`mkdir ${absPath} failed: ${res.stderr.trim()}`);
    }
  }

  async access(containerId: string, absPath: string): Promise<void> {
    const res = await this.run(containerId, 'test', ['-e', absPath], {
      timeoutMs: 5_000,
    });
    if (res.exitCode !== 0) {
      throw Object.assign(new Error(`ENOENT: ${absPath}`), { code: 'ENOENT' });
    }
  }

  async readdir(containerId: string, absPath: string): Promise<SandboxReaddirEntry[]> {
    // `-A` lists all entries except `.` and `..`. `-F` appends a one-char
    // type indicator (`/` for dir, `*` for exec, `@` for symlink, nothing
    // for regular file). We parse that rather than running a slower
    // `find -maxdepth 1 -printf ...` invocation.
    const res = await this.run(containerId, 'ls', ['-A', '-F', '--', absPath], {
      timeoutMs: 10_000,
    });
    if (res.exitCode !== 0) {
      throw new Error(`readdir ${absPath} failed: ${res.stderr.trim()}`);
    }
    const out: SandboxReaddirEntry[] = [];
    for (const raw of res.stdout.split('\n')) {
      if (!raw) continue;
      const last = raw[raw.length - 1];
      if (last === '/') out.push({ name: raw.slice(0, -1), kind: 'dir' });
      else if (last === '@' || last === '*' || last === '|' || last === '=') {
        out.push({ name: raw.slice(0, -1), kind: 'other' });
      } else {
        out.push({ name: raw, kind: 'file' });
      }
    }
    return out;
  }

  // ─────────────────────────────────────────────────────────────── stats

  async stats(containerId: string): Promise<SandboxStatsSample | null> {
    // `docker stats --no-stream --format '{{json .}}' <id>` returns one
    // JSON line with human-formatted CPU% and memory (e.g. "12.3%",
    // "245.8MiB / 1GiB"). Podman accepts the same flags and emits a
    // slightly different shape — we parse defensively.
    const res = await this.cli(
      [
        ...this.globalArgs,
        'stats',
        '--no-stream',
        '--format',
        '{{json .}}',
        containerId,
      ],
      { timeoutMs: 5_000 },
    );
    if (res.exitCode !== 0) return null;
    const line = res.stdout.split('\n').find((l) => l.trim().startsWith('{'));
    if (!line) return null;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return null;
    }
    const cpuPercent = parsePercent(
      (parsed.CPUPerc ?? parsed.CPU ?? parsed.cpu_percent) as string | undefined,
    );
    const memBytes = parseMemBytes(
      (parsed.MemUsage ?? parsed.memory_stats ?? parsed.mem_usage) as string | undefined,
    );
    if (cpuPercent === null && memBytes === null) return null;
    return {
      cpuPercent: cpuPercent ?? 0,
      memBytes: memBytes ?? 0,
      sampledAt: Date.now(),
    };
  }

  // ─────────────────────────────────────────────────────────── archive

  async exportWorkdir(containerId: string, workdir: string): Promise<Buffer> {
    // `<runtime> cp <id>:<path> -` emits a tar archive on stdout. We
    // must capture the raw bytes; `IShellPort` is a string-oriented
    // abstraction, so we spawn the CLI directly for this one call.
    return await this.streamExportToBuffer(containerId, workdir);
  }

  async importWorkdir(containerId: string, workdir: string, tar: Buffer): Promise<void> {
    const staging = await mkdtemp(join(tmpdir(), 'mcp-sbx-import-'));
    const tarPath = join(staging, 'workdir.tar');
    try {
      await hostWriteFile(tarPath, tar);
      // Ensure target exists; `docker cp <file> <id>:<dir>` requires it.
      await this.mkdir(containerId, workdir, { recursive: true });
      // The `-a` flag preserves ownership — matters when the container
      // runs as a non-root user and the tar was written as root.
      const res = await this.cli(
        [...this.globalArgs, 'cp', '-a', tarPath, `${containerId}:${workdir}`],
        { timeoutMs: 60_000 },
      );
      if (res.exitCode !== 0) {
        throw new Error(
          `${this.binary} cp import failed: ${res.stderr.trim() || res.stdout.trim()}`,
        );
      }
      // The imported tar lands as `<workdir>/workdir.tar` (a file), not
      // extracted — `docker cp <host-file> <id>:<container-dir>` copies
      // the file in. Extract manually.
      const extract = await this.exec(
        containerId,
        `cd ${workdir} && tar -xf workdir.tar && rm workdir.tar`,
        { cwd: workdir, timeoutMs: 60_000 },
      );
      if (extract.exitCode !== 0) {
        throw new Error(`tar extract failed: ${extract.stderr.trim() || extract.stdout.trim()}`);
      }
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }

  /**
   * Stream `docker cp <id>:<path> -` into a Buffer. We spawn the CLI
   * directly here (bypassing `IShellPort`) because the shell port is a
   * string-oriented abstraction and this is the one place where we
   * truly need raw binary bytes — a tar archive.
   */
  private async streamExportToBuffer(containerId: string, workdir: string): Promise<Buffer> {
    const { spawn } = await import('node:child_process');
    return await new Promise<Buffer>((resolve, reject) => {
      const child = spawn(
        this.binary,
        [...this.globalArgs, 'cp', `${containerId}:${workdir}`, '-'],
        { cwd: this.cwd, windowsHide: true, detached: process.platform !== 'win32' },
      );
      const untrack = trackProcessTree(child.pid);
      const chunks: Buffer[] = [];
      let stderr = '';
      child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf-8');
      });
      child.once('error', (error) => {
        untrack();
        reject(error);
      });
      child.once('close', (code) => {
        untrack();
        if (code !== 0) {
          reject(new Error(`${this.binary} cp export (stream) failed: ${stderr.trim()}`));
          return;
        }
        resolve(Buffer.concat(chunks));
      });
    });
  }

  // ────────────────────────────────────────────────────────────── health

  async isPortListening(hostPort: number): Promise<boolean> {
    const { createConnection } = await import('node:net');
    return await new Promise<boolean>((resolve) => {
      const socket = createConnection({ host: '127.0.0.1', port: hostPort });
      const finish = (ok: boolean) => {
        socket.removeAllListeners();
        socket.destroy();
        resolve(ok);
      };
      socket.once('connect', () => finish(true));
      socket.once('error', () => finish(false));
      socket.setTimeout(1_000, () => finish(false));
    });
  }

  // ─────────────────────────────────────────────────────────── diagnostics

  async getContainerLogs(containerId: string, tail = 200): Promise<string> {
    // `docker/podman logs --tail N <id>` emits both stdout+stderr
    // (unless `--details` is passed, which we skip). Never throw —
    // diagnostics are best-effort; callers use this in error paths
    // where an extra failure would just mask the real one.
    try {
      const res = await this.cli(
        [...this.globalArgs, 'logs', '--tail', String(tail), '--timestamps', containerId],
        { timeoutMs: 10_000 },
      );
      if (res.timedOut) return '';
      // `logs` writes container stdout to our stdout and container
      // stderr to our stderr — preserve the split so callers can see
      // error output even when the app kept writing to stdout.
      const parts: string[] = [];
      if (res.stdout.trim()) parts.push(res.stdout.trimEnd());
      if (res.stderr.trim()) parts.push(`--- stderr ---\n${res.stderr.trimEnd()}`);
      return parts.join('\n');
    } catch {
      return '';
    }
  }

  async getContainerState(containerId: string): Promise<SandboxStateSnapshot | null> {
    try {
      const res = await this.cli(
        [
          ...this.globalArgs,
          'inspect',
          '--format',
          '{{json .State}}',
          containerId,
        ],
        { timeoutMs: 10_000 },
      );
      if (res.timedOut || res.exitCode !== 0) return null;
      const line = res.stdout.trim();
      if (!line) return null;
      const parsed = JSON.parse(line) as Record<string, unknown>;
      return {
        exitCode:
          typeof parsed.ExitCode === 'number'
            ? (parsed.ExitCode as number)
            : null,
        oomKilled: parsed.OOMKilled === true,
        error: typeof parsed.Error === 'string' ? (parsed.Error as string) : '',
        startedAt: typeof parsed.StartedAt === 'string' ? (parsed.StartedAt as string) : '',
        finishedAt: typeof parsed.FinishedAt === 'string' ? (parsed.FinishedAt as string) : '',
      };
    } catch {
      return null;
    }
  }

  // ────────────────────────────────────────────────────────────── image mgmt

  /**
   * Ensure a local image exists, building it from `buildContextPath` if not.
   * Called once at driver initialisation so `create()` never hits a remote
   * registry for a locally-managed image.
   */
  async ensureImage(image: string, buildContextPath: string): Promise<void> {
    const check = await this.shell.spawn(
      this.binary,
      [...this.globalArgs, 'images', '-q', image],
      { cwd: this.cwd, env: process.env, timeoutMs: 15_000 },
    );
    if (check.stdout.trim()) return; // image already present

    console.log(`[sandbox] image "${image}" not found locally — building from ${buildContextPath}`);
    const build = await this.shell.spawn(
      this.binary,
      [...this.globalArgs, 'build', '-t', image, buildContextPath],
      { cwd: this.cwd, env: process.env, timeoutMs: 10 * 60_000 },
    );
    if (build.exitCode !== 0) {
      throw new Error(
        `${this.binary} build failed (exit ${build.exitCode}): ${build.stderr.trim() || build.stdout.trim()}`,
      );
    }
  }

  // ───────────────────────────────────────────────────────────── internals

  /**
   * Invoke the CLI with argv. Uses `IShellPort.spawn` (argv, no shell,
   * async streaming) so args pass through intact AND the host Node
   * event loop keeps turning while long container commands run
   * (`docker exec … sh -c "npm install"` can last minutes — spawnSync
   * would freeze every other HTTP request, SSE heartbeat, and timer).
   */
  protected async cli(args: string[], options: SandboxExecOptions): Promise<ShellExecResult> {
    return await this.shell.spawn(this.binary, args, {
      cwd: this.cwd,
      env: process.env,
      timeoutMs: options.timeoutMs ?? this.defaultTimeoutMs,
      signal: options.signal,
      maxOutputBytes: options.maxOutputBytes,
      stdin: options.stdin,
    });
  }

  /**
   * Surface SIGKILL-from-timeout as a real error instead of letting it
   * masquerade as a business result. Callers such as `inspectContainer`
   * would otherwise interpret `{ exitCode: null }` as "container gone"
   * and drive destructive reconcile decisions (row deletion, forced
   * re-provision) on what is really just host-side slowness.
   */
  private throwIfTimedOut(res: ShellExecResult, op: string): void {
    if (res.timedOut) {
      throw new Error(
        `${this.binary} ${op} timed out after ${this.defaultTimeoutMs}ms (process killed)`,
      );
    }
  }

  private toSandboxResult(r: ShellExecResult): SandboxExecResult {
    return {
      stdout: r.stdout,
      stderr: r.stderr,
      exitCode: r.exitCode,
      timedOut: r.timedOut,
    };
  }

  private async ensureParentDir(containerId: string, absPath: string): Promise<void> {
    const parent = posix.dirname(absPath);
    if (!parent || parent === '/' || parent === '.') return;
    await this.mkdir(containerId, parent, { recursive: true });
  }
}

// `sanitizeContainerName` + `parsePercent` + `parseMemBytes` moved to
// `cli-oci/helpers.ts` so the regex / unit-conversion logic can be
// unit-tested without spinning a fake shell. Re-imported above.
