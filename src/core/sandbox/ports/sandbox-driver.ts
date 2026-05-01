/**
 * Sandbox driver port — the contract every container runtime implementation
 * must satisfy (Docker, Podman, E2B, future microVM backends).
 *
 * SOLID:
 *   - DIP: `SandboxManager` and the adapters depend on this interface, not
 *     on any concrete runtime. Swapping runtime = swapping one class.
 *   - LSP: every method's effect is specified here. A driver that fails to
 *     honor the contract (e.g. lossy `writeFile`) breaks its substitutability.
 *   - ISP: the surface is kept minimal — just what the adapters and the
 *     manager genuinely need. Add methods only when a real caller demands.
 *
 * All paths are ABSOLUTE, container-side paths (e.g. `/app/src/main.tsx`).
 * Host-to-container path mapping is the caller's job, not the driver's.
 */

import type { SandboxIsolation, SandboxLimits, SandboxStack } from '../types.js';

export interface SandboxCreateSpec {
  /** Stable id (reuses companySessionId). Drivers label containers with this. */
  sandboxId: string;
  /** OCI image tag the scaffolder expects (e.g. `mcp-sandbox-node:20`). */
  image: string;
  stack: SandboxStack;
  /** Container-internal working directory (usually `/app`). */
  workdir: string;
  /** Host port to bind onto the container's dev-server port. */
  hostPort: number;
  /** Container port the dev server listens on (e.g. 5173 for Vite). */
  containerPort: number;
  /**
   * Host interface to bind the published port on. Defaults to
   * `127.0.0.1` (loopback only) so sandbox containers don't accidentally
   * expose dev servers on the LAN. Set to `0.0.0.0` for shared
   * infrastructure containers (e.g. the Chrome Service singleton)
   * that other containers must reach via `host.containers.internal` /
   * `host.docker.internal`, since those aliases resolve to the
   * container-network gateway, not host loopback.
   */
  hostBindAddr?: string;
  limits: SandboxLimits;
  /** Isolation / hardening flags. Drivers MUST honor every field. */
  isolation: SandboxIsolation;
  /** Environment variables to set inside the container. */
  env?: Record<string, string>;
  /**
   * Absolute HOST path to bind-mount onto `workdir` inside the container.
   * When set, the workspace lives on the host filesystem and survives
   * any runtime-level death of the container (SIGKILL, Docker restart,
   * API server crash). Omit for the legacy ephemeral-fs behavior where
   * persistence requires an explicit `exportWorkdir`/`saveArchive` cycle.
   *
   * Callers MUST ensure the directory exists and is writable before
   * calling `create()` — the driver does not `mkdir -p` for you.
   */
  hostWorkdirMount?: string;
  /**
   * When present, mount a named volume at `<workdir>/node_modules` so
   * dependency installs don't fight the host bind-mount (slow on
   * Docker Desktop Windows/macOS, and risks leaking linux-arch binaries
   * onto the host). Requires `hostWorkdirMount` to be meaningful — if
   * only this is set (no bind mount) the container has no persistence
   * for anything outside `node_modules`.
   */
  nodeModulesVolumeName?: string;
}

export interface SandboxExecResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
}

export interface SandboxExecOptions {
  /** Working directory inside the container. Defaults to the sandbox workdir. */
  cwd?: string;
  timeoutMs: number;
  signal?: AbortSignal;
  maxOutputBytes?: number;
  env?: Record<string, string>;
  /**
   * Override the user this specific exec runs as (e.g. `'0:0'` to run
   * as root even though the container's default user is unprivileged).
   * Used by the manager's `prepareWorkdir` step to create and chown
   * `/app` before handing control over to unprivileged scaffolding.
   *
   * `null` → use the container's default user (whatever was set on run).
   */
  user?: string | null;
  /**
   * Optional payload written to the child process stdin. CLI-based
   * drivers (Docker/Podman) emit `exec -i` and pipe this through the
   * host shell. Used by `run_command` to deliver multi-line code to
   * interpreters (e.g. `python -`) without shell-quoting headaches.
   */
  stdin?: string;
}

export interface SandboxReaddirEntry {
  name: string;
  kind: 'dir' | 'file' | 'other';
}

export interface ISandboxDriver {
  /** Informational — used by the manager for logs and for `Sandbox.runtime`. */
  readonly runtime: 'docker' | 'podman' | 'e2b';

  /**
   * Create and start the container. Returns the runtime-assigned
   * containerId. The container must be running on return; scaffolding
   * happens after via `exec`.
   */
  create(spec: SandboxCreateSpec): Promise<{ containerId: string }>;

  /** Stop and remove the container. Idempotent — removing a gone container is a no-op. */
  destroy(containerId: string): Promise<void>;

  /**
   * Report whether the container still exists in the runtime and
   * whether its main process is running. Used by the manager on boot
   * to reconcile its DB with the actual runtime state — a container
   * that was persisted but no longer exists (pruned, VM reset, etc.)
   * must fall through to the archive-restore path.
   */
  inspectContainer(containerId: string): Promise<SandboxInspectResult>;

  /**
   * Start a stopped container (paused or crashed). Container must
   * exist; use `create()` for fresh ones. Idempotent — starting an
   * already-running container is a no-op.
   */
  startContainer(containerId: string): Promise<void>;

  /**
   * Gracefully stop a running container (SIGTERM, then SIGKILL after
   * grace). Preserves the filesystem layer so a subsequent `start`
   * resumes instantly. Idempotent.
   */
  stopContainer(containerId: string, graceSeconds?: number): Promise<void>;

  /**
   * Run a shell-parsed command inside the container. Equivalent to
   * `docker exec <id> sh -c "<command>"`. Streams output is captured,
   * truncated and returned.
   */
  exec(
    containerId: string,
    command: string,
    options: SandboxExecOptions,
  ): Promise<SandboxExecResult>;

  /**
   * Run a program with discrete argv — NO shell parsing. Mirrors
   * `IShellPort.run` semantics so the SandboxShellAdapter can route
   * `git_*` calls safely.
   */
  run(
    containerId: string,
    program: string,
    args: string[],
    options: SandboxExecOptions,
  ): Promise<SandboxExecResult>;

  /** Write a file atomically. Creates parent dirs when `recursive` is true. */
  writeFile(
    containerId: string,
    absPath: string,
    data: string,
    options?: { recursive?: boolean },
  ): Promise<void>;

  /** Read a file as utf-8. Throws when the file is missing. */
  readFile(containerId: string, absPath: string): Promise<string>;

  /** Create a directory. `recursive: true` tolerates existing dirs. */
  mkdir(containerId: string, absPath: string, options?: { recursive?: boolean }): Promise<void>;

  /** Resolve or throw — used to honor `IFilesystemPort.access`. */
  access(containerId: string, absPath: string): Promise<void>;

  /** List directory entries (name + kind). */
  readdir(containerId: string, absPath: string): Promise<SandboxReaddirEntry[]>;

  /**
   * Quick liveness check. Returns true when the container is running and
   * the dev-server port responds to a plain TCP connect (caller supplies
   * the port). Manager uses this to flip status to `ready`.
   */
  isPortListening(hostPort: number): Promise<boolean>;

  /**
   * Sample CPU% and memory usage for a running container. Implementations
   * may return `null` when the runtime refuses to report stats (e.g. the
   * container is paused or gone) — callers treat that as "no sample this
   * tick" and don't emit an event.
   */
  stats(containerId: string): Promise<SandboxStatsSample | null>;

  /**
   * Stream the entire `workdir` out of the container as a tar archive
   * (the format `<runtime> cp <id>:<path> -` produces natively). The
   * returned Buffer holds the complete archive bytes; manager uses it
   * for session archive/restore.
   */
  exportWorkdir(containerId: string, workdir: string): Promise<Buffer>;

  /**
   * Restore a previously-exported tar archive into `workdir`. The
   * archive format must match `exportWorkdir`'s output. Called by the
   * manager when a session with a saved archive is re-provisioned.
   */
  importWorkdir(containerId: string, workdir: string, tar: Buffer): Promise<void>;

  /**
   * Capture the container's last stdout/stderr (most recent `tail`
   * lines). Used for post-mortem diagnostics when a sandbox fails to
   * start or dies unexpectedly — we want to tell the user WHY rather
   * than just destroy the container and move on. Returns empty string
   * when the container is gone or the runtime refuses; never throws.
   */
  getContainerLogs(containerId: string, tail?: number): Promise<string>;

  /**
   * Inspect the container's last-known process state: exit code, OOM
   * flag, runtime error string. Complements `inspectContainer`, which
   * answers "does it exist / is it running now" — this answers "why
   * did it stop". Returns `null` when the container is gone or the
   * runtime can't produce a state record; never throws.
   */
  getContainerState(containerId: string): Promise<SandboxStateSnapshot | null>;
}

export interface SandboxStateSnapshot {
  /** Last exit code observed by the runtime (`null` when still running). */
  exitCode: number | null;
  /** True when the container was killed by the OOM-killer. */
  oomKilled: boolean;
  /** Runtime-reported error string (Podman/Docker sometimes populate this). */
  error: string;
  /** ISO timestamp when the main process last started. Empty when unknown. */
  startedAt: string;
  /** ISO timestamp when the main process last exited. Empty when running. */
  finishedAt: string;
}

export interface SandboxStatsSample {
  /** Percentage (0-100) of a single CPU core. May exceed 100 on multi-core hosts. */
  cpuPercent: number;
  /** Resident memory in bytes. */
  memBytes: number;
  /** Sampled epoch ms. */
  sampledAt: number;
}

export interface SandboxInspectResult {
  /** `true` when the runtime knows about the container (running or stopped). */
  exists: boolean;
  /** `true` only when the container's main process is currently running. */
  running: boolean;
  /** Container-reported labels; subset of what we set on `create()`. */
  labels: Record<string, string>;
}
