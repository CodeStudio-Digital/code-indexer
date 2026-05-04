/**
 * Sandbox runtime domain types.
 *
 * A Sandbox is an ephemeral, per-session OCI container that hosts a
 * generated project (Vite, Next.js, Laravel, etc.) and exposes a dev
 * server on a host-mapped port so the dashboard can iframe it.
 *
 * These types are transport-agnostic: they describe WHAT a sandbox is,
 * not HOW a specific driver implements it. Consumers of `ISandboxDriver`
 * depend on this module only.
 */

export type SandboxStatus =
  /** The manager accepted the request but the driver hasn't started provisioning yet. */
  | 'pending'
  /** Driver is pulling images, creating/starting container, running scaffolder. */
  | 'provisioning'
  /** Container is up, dev server responded on its port. `previewUrl` is valid. */
  | 'ready'
  /**
   * Container was `podman stop`'d by the soft-TTL reaper after an idle
   * period. Filesystem layer is preserved; resume is fast (start +
   * relaunch dev server, no re-install). Hard-TTL eventually promotes
   * a paused sandbox to 'destroyed'.
   */
  | 'paused'
  /** Provisioning or runtime error. `error` carries the human-readable reason. */
  | 'error'
  /** Manager is stopping/removing the container (TTL expiry, session end, shutdown). */
  | 'destroying'
  /** Container removed and reaped. Terminal. */
  | 'destroyed';

export type SandboxMountKind = 'owned' | 'external';
export type SandboxImageSource = 'default' | 'project_dockerfile';

/**
 * The stacks this repository knows about.
 *
 * Container-backed stacks (`react-ts`, `vue-ts`, `angular`, `vite-api`,
 * `cf-worker`) all have an `IScaffolder` registered in `scaffolders/registry.ts`
 * and are provisioned by `SandboxManager` inside a Podman/Docker container.
 *
 * `local-process` is a deprecated marker — it identifies host-process projects owned
 * by the `LocalProcessManager`. It never flows through the scaffolder
 * registry (calling `getScaffolder('local-process')` throws); it only
 * remains here so legacy cleanup/status code keeps compiling.
 */
export type SandboxStack =
  | 'react-ts'
  | 'vue-ts'
  | 'angular'
  | 'vite-api'
  | 'cf-worker'
  | 'local-process'
  /**
   * Bare Node.js sandbox — no scaffolding, no dev server, no preview.
   * Used by Design System Creator sessions: the agent receives a
   * container with Node + npm + git, the virtual project root is
   * bind-mounted at `/app`, and the uploaded theme sits ready at
   * `/app/design_system/`. The pipeline does NOT need a Vite app
   * scaffold — that pollutes the workdir with `package.json`, `src/`,
   * `node_modules/` etc. and confuses the extractor about what's
   * "the theme" vs. "the scaffold".
   */
  | 'node-only';

/**
 * Subset of `SandboxStack` actually exposed as selectable options in the
 * dashboard's builder-mode UI. The other stacks in `SandboxStack` (e.g.
 * `vite-api`, `cf-worker`) exist as scaffolder hooks but aren't user-facing
 * today. Kept here so core modules (seeders, scaffolders) can type against
 * the builder-mode subset without importing from the http-api layer.
 */
export const BUILDER_STACKS = ['react-ts', 'vue-ts', 'angular', 'vite-api', 'cf-worker'] as const;
export type BuilderStack = (typeof BUILDER_STACKS)[number];

/**
 * Stacks the sandbox lifecycle routes (GET/POST /sandbox, restart-dev,
 * logs) accept. Superset of `BUILDER_STACKS`: includes internal-only
 * stacks like `'node-only'` (used by Design System Creator) that aren't
 * exposed in user-facing pickers but still need to be provisionable,
 * inspectable, and restartable from the dashboard / API.
 *
 * Keep `BUILDER_STACKS` for user-input validation (NewCompanyDialog
 * options, snapshot seeding) and `PROVISIONABLE_STACKS` for routes that
 * touch any session backed by a real container.
 */
export const PROVISIONABLE_STACKS = [...BUILDER_STACKS, 'node-only'] as const;
export type ProvisionableStack = (typeof PROVISIONABLE_STACKS)[number];

export interface SandboxLimits {
  /** Memory limit passed to the OCI runtime (e.g. "1g", "512m"). */
  memory: string;
  /** CPU shares / cores as a CLI-compatible string (e.g. "1", "0.5"). */
  cpus: string;
  /** PID limit — caps fork bombs. */
  pids: number;
}

/**
 * Security posture applied to every sandbox container. Intentionally
 * opt-OUT rather than opt-IN — the safe defaults kick in automatically
 * for every caller. Operators can tune via the `MCP_SANDBOX_*` env vars
 * documented on each field.
 *
 * Rationale for each flag:
 *   - `user`        → run the container process as a non-root UID, so
 *     an `rm -rf /` by the LLM deletes nothing of value (the container
 *     is ephemeral anyway, but this also blocks privilege-dependent
 *     escapes that require `root` inside the container).
 *   - `dropAllCaps` → strip Linux capabilities (NET_ADMIN, SYS_ADMIN,
 *     etc). The dev server only needs bind(2) on an unprivileged port,
 *     which requires none.
 *   - `noNewPrivs` → blocks setuid/setgid escalations via new exec()s.
 *   - `readOnlyRoot` → container rootfs is mounted read-only; `/app`
 *     and `/tmp` are the only writable mounts (managed by the runtime
 *     and a tmpfs, respectively).
 */
export interface SandboxIsolation {
  /** `--user` value (e.g. `1000:1000`, `node`, `''` to skip). */
  user: string;
  dropAllCaps: boolean;
  noNewPrivs: boolean;
  readOnlyRoot: boolean;
  /**
   * Absolute path to a seccomp JSON profile to load via
   * `--security-opt seccomp=<path>`. `null` keeps the runtime default
   * profile; `'unconfined'` disables seccomp entirely (not recommended).
   */
  seccompProfile: string | null | 'unconfined';
  /**
   * Docker/Podman network name the sandbox joins. `null` uses the
   * runtime default bridge. Set to `'mcp-sandbox-net'` (or similar) to
   * opt into the egress-firewall network provisioned by the
   * `NetworkController` (see phase 6b).
   */
  network: string | null;
  /**
   * HTTP proxy URL injected as `HTTP_PROXY`/`HTTPS_PROXY` env vars. When
   * combined with an isolated network that denies direct egress, forces
   * `npm install` and friends through a squid allow-list.
   */
  httpProxy: string | null;
}

/**
 * Default CPU/memory ceiling for every sandbox container, tunable via
 * env. Each session can override individual fields through its
 * `builder.limits` payload on `POST /api/company/sessions` — the
 * resolver at `SandboxManager.provision` layers session → env → hard
 * defaults so partial overrides work cleanly.
 *
 *   MCP_SANDBOX_MEMORY (e.g. "512m", "1g", "2g") — default "1g"
 *   MCP_SANDBOX_CPUS   (e.g. "0.5", "1", "2")    — default "1"
 *   MCP_SANDBOX_PIDS   (positive integer)         — default 256
 */
export const DEFAULT_SANDBOX_LIMITS: SandboxLimits = {
  memory: process.env.MCP_SANDBOX_MEMORY ?? '1g',
  cpus: process.env.MCP_SANDBOX_CPUS ?? '1',
  pids: Number(process.env.MCP_SANDBOX_PIDS ?? '256') || 256,
};

export const DEFAULT_SANDBOX_ISOLATION: SandboxIsolation = {
  // The pre-warm Dockerfile runs as root by default; we pin to the
  // `node` user (uid 1000 in the official node image family) so nothing
  // in `/app` ends up root-owned. If your custom image uses a different
  // non-root user, override via MCP_SANDBOX_USER.
  user: process.env.MCP_SANDBOX_USER ?? '1000:1000',
  // Default OFF. Rationale:
  //   - In rootless Podman (and `docker --userns-remap`), the container
  //     is ALREADY unprivileged via user-namespace mapping — the host
  //     UID is your real unprivileged user. Dropping all Linux caps on
  //     top buys little additional safety.
  //   - Dropping all caps removes CHOWN / FOWNER / DAC_OVERRIDE, which
  //     breaks common filesystem-setup operations (including our own
  //     `prepareWorkdir` that ensures /app exists and is writable),
  //     producing "chown: Operation not permitted" failures as root.
  //   - Operators who run privileged (rootful) Docker and want the
  //     defense-in-depth can opt in with MCP_SANDBOX_DROP_CAPS=1.
  dropAllCaps: process.env.MCP_SANDBOX_DROP_CAPS === '1',
  noNewPrivs: process.env.MCP_SANDBOX_NO_NEW_PRIVS !== '0',
  // Read-only root is off by default because npm install writes into
  // `/root/.npm` during the first invocation inside the container, and
  // the primer image pre-warms that cache under /root. Enable via
  // MCP_SANDBOX_READONLY_ROOT=1 once a dedicated `/home/node/.npm`
  // cache is plumbed into the Dockerfile (tracked for a follow-up).
  readOnlyRoot: process.env.MCP_SANDBOX_READONLY_ROOT === '1',
  // Seccomp profile path. Default is `null` — use the OCI runtime's own
  // default profile (already restrictive on Docker; permissive on plain
  // Podman). Ops can point at `docker/sandbox-node/seccomp.json` to
  // load the stricter MCP profile that denies mount/unshare/bpf/etc.
  seccompProfile: process.env.MCP_SANDBOX_SECCOMP ?? null,
  // Network: `null` uses the default bridge (direct egress). Setting
  // this to `mcp-sandbox-net` pairs with the egress firewall (phase 6b).
  network: process.env.MCP_SANDBOX_NETWORK ?? null,
  // HTTP proxy: when combined with a deny-egress network, this forces
  // all traffic through the allow-listed squid sidecar. `null` = direct.
  httpProxy: process.env.MCP_SANDBOX_HTTP_PROXY ?? null,
};

/**
 * Granular provisioning sub-step. Lets the UI render a meaningful
 * "currently doing X" label instead of a generic spinner for 60+ seconds.
 * Values map 1:1 to the scaffolder pipeline — adding a new step means
 * adding one emit in the scaffolder and one label in the UI.
 */
export type SandboxStep =
  | 'queued'
  | 'creating-container'
  | 'scaffolding'
  | 'installing-deps'
  | 'starting-dev-server'
  | 'ready'
  | 'error';

export interface Sandbox {
  /** Stable id = the companySessionId that owns the sandbox. */
  id: string;
  /** Runtime-assigned container id (full sha256 when available). */
  containerId: string;
  /** OCI runtime that created the container. Informational. */
  runtime: 'docker' | 'podman' | 'e2b';
  /** Which stack was scaffolded. */
  stack: SandboxStack;
  /** Host port mapped to the container's dev-server port. */
  hostPort: number;
  /** Container-internal path the scaffolder populated (typically `/app`). */
  workdir: string;
  /** Container-side port published by the runtime. Defaults to 5173 for scaffolded stacks. */
  containerPort: number;
  /** Absolute URL the dashboard can iframe. Always goes through the API proxy. */
  previewUrl: string;
  /** Final (resolved) CPU/memory/pids limits the container was created with. */
  limits: SandboxLimits;
  status: SandboxStatus;
  /**
   * True when the OCI runtime has frozen the container via `podman
   * pause` / `docker pause`. This is deliberately separate from
   * `status='paused'`, which means the manager's soft-TTL stopped the
   * container and can auto-resume it.
   */
  runtimePaused?: boolean;
  /** Granular sub-step within `status`. Drives the provisioning UI label. */
  step: SandboxStep;
  /** Last error string when `status === 'error'`. */
  error?: string;
  /**
   * Ring buffer of the most recent log/step lines emitted during
   * provisioning and scaffolding. Capped at ~200 entries; older ones
   * drop off the front. Exposed via `GET /sandbox` so the UI can show
   * a live tail without opening a second stream.
   */
  recentLogs: SandboxLogLine[];
  createdAt: number;
  /** Last time any tool (fs/shell) touched this sandbox. Drives TTL eviction. */
  lastAccessAt: number;
  /**
   * Host path bind-mounted onto `workdir`. When set, the workspace
   * persists on the host across container death and tar archive
   * export/restore is a no-op for this sandbox.
   */
  hostWorkdirMount?: string;
  /** Named volume backing `<workdir>/node_modules` (only when hostWorkdirMount is set). */
  nodeModulesVolumeName?: string;
  /** Whether this bind mount is disposable builder-owned storage or a user's existing project. */
  mountKind: SandboxMountKind;
  /** Whether the container image is the MCP default image or was built from the project root. */
  imageSource: SandboxImageSource;
  /** Deterministic tag for images built from project Dockerfiles. */
  builtImageTag?: string;
  /** Absolute path to the project Dockerfile/Containerfile used for the image build. */
  dockerfilePath?: string;
  /** First EXPOSE port selected from the project Dockerfile. */
  dockerfileExposedPort?: number;
  /**
   * True when this sandbox references a container that lives outside
   * the platform's lifecycle. The manager only inspects it; start,
   * stop, pause, restart and destroy are no-ops for these entries.
   */
  attached?: boolean;
  /** User-supplied id/name of the externally-managed container. */
  externalContainerRef?: string;
  /** DNS hostname peer containers use to reach the attached service. */
  attachedHostname?: string;
}

export interface SandboxLogLine {
  /** Epoch ms. */
  at: number;
  level: 'info' | 'error';
  /** Short human-readable message. No ANSI. */
  text: string;
}

export type SandboxEvent =
  | { kind: 'provisioning'; sandboxId: string; stack: SandboxStack }
  | { kind: 'step'; sandboxId: string; step: SandboxStep; message: string }
  | { kind: 'log'; sandboxId: string; stream: 'stdout' | 'stderr'; chunk: string }
  | { kind: 'ready'; sandboxId: string; previewUrl: string }
  | { kind: 'paused'; sandboxId: string; reason: string }
  | { kind: 'resumed'; sandboxId: string; previewUrl: string }
  | { kind: 'error'; sandboxId: string; message: string }
  | { kind: 'destroying'; sandboxId: string; reason: string }
  | { kind: 'destroyed'; sandboxId: string }
  | {
      kind: 'stats';
      sandboxId: string;
      cpuPercent: number;
      memBytes: number;
      sampledAt: number;
    };

export interface SandboxObserver {
  (event: SandboxEvent): void;
}
