import type { PortAllocator } from '../port-allocator.js';
import type { ISandboxDriver } from '../ports/sandbox-driver.js';
import type {
  SandboxImageSource,
  SandboxMountKind,
  SandboxStack,
} from '../types.js';

export const DEFAULT_MAX = 10;
export const DEFAULT_IDLE_TTL = 30 * 60 * 1000;
export const DEFAULT_NODE_IMAGE = 'mcp-sandbox-node:20-py';
export const DEFAULT_DEV_PORT = 5173;
export const DEFAULT_WORKDIR = '/app';

export interface SandboxManagerOptions {
  driver?: ISandboxDriver;
  allocator?: PortAllocator;
  /** Max concurrent sandboxes. Defaults to 10 (env: MCP_MAX_SANDBOXES). */
  maxSandboxes?: number;
  /** Idle time before auto-destroy. Defaults to 30 min (env: MCP_SANDBOX_IDLE_MS). */
  idleTtlMs?: number;
  /** Base image for Node-stack sandboxes. Defaults to `localhost/mcp-sandbox-node:20-py`. */
  nodeImage?: string;
  /** Container port the dev server binds to. Defaults to 5173 (Vite). */
  devServerPort?: number;
  /** Absolute container path used as workdir. Defaults to `/app`. */
  workdir?: string;
  /** Interval for `sandbox.stats` sampling. 0 disables. Default 15s. */
  statsIntervalMs?: number;
  /**
   * Skip the SIGTERM/SIGINT shutdown handlers. Set to true in test fixtures
   * that build a one-off manager per test: production binds a single
   * process-wide singleton via `getSandboxManager()`, so leaving the handlers
   * in tests means every fresh manager piles `process.once('SIGTERM', …)`
   * listeners and Node warns about an EventEmitter leak after 11+ tests in
   * the same file.
   */
  skipShutdownHandlers?: boolean;
  /**
   * Build the public preview URL from `hostPort` + `sandboxId`. When the API
   * server proxies `/preview/:sessionId/*`, the URL is origin-relative and
   * this returns just the path. Override when running behind a subdomain
   * strategy.
   */
  buildPreviewUrl?: (sessionId: string, hostPort: number) => string;
}

export interface ProvisionRequest {
  sessionId: string;
  stack: SandboxStack;
  signal?: AbortSignal;
  /**
   * Optional archive to restore into the workdir after container start, in
   * place of running the scaffolder. Used by `SandboxService` when resuming
   * a session that was archived at teardown.
   */
  restoreArchive?: Buffer;
  /**
   * When true, a pre-existing sandbox record in `error` state for this
   * session is torn down first and recreated fresh. Normal (non-retry)
   * calls just return the existing record.
   */
  retry?: boolean;
  /**
   * Per-session override of the CPU/memory/pids ceiling. Any field left
   * `undefined` falls back to `DEFAULT_SANDBOX_LIMITS` (which itself
   * respects `MCP_SANDBOX_*` env vars).
   */
  limits?: Partial<import('../types.js').SandboxLimits>;
  /**
   * Absolute host path to bind-mount onto the primary workdir. When
   * provided, the manager skips its default sessionId-based layout and
   * uses this instead — so the sandbox writes to the SAME directory the
   * session's virtual project row points at.
   */
  hostWorkdirMount?: string;
  mountKind?: SandboxMountKind;
  imageSource?: SandboxImageSource;
  dockerfilePath?: string;
  containerPortOverride?: number;
  skipDefaultCommand?: boolean;
  /**
   * When true the session has at least one role with the `qa-playwright`
   * skill, so the scaffolder writes a Playwright client config + reporter
   * and the caller provisions a separate `playwright-sidecar` container.
   * Project container stays lean (~592 MB), browser lives in the sidecar.
   * The legacy env var `MCP_SANDBOX_INCLUDE_E2E=1` works as a global override.
   */
  includeE2e?: boolean;
}

/**
 * Request to stand up a SECONDARY container for a session. Used for
 * multi-microservice sessions (frontend + worker + php). Secondary services
 * can be started independently of the primary sandbox.
 */
export interface ProvisionServiceRequest {
  sessionId: string;
  /** Stable token — also the in-network hostname. */
  serviceId: string;
  /** Free-form stack key (validated by the scaffolder registry). */
  stack: SandboxStack;
  /** Display label shown in the dashboard; falls back to serviceId. */
  name?: string;
  limits?: Partial<import('../types.js').SandboxLimits>;
  signal?: AbortSignal;
  /**
   * Absolute host path to bind-mount onto the service workdir. When the
   * route layer creates a real `projects` row for this service (so it shows
   * up in the dashboard's Projects list and can be indexed), it passes the
   * project's `root_path` here.
   */
  hostWorkdirMount?: string;
  mountKind?: SandboxMountKind;
  imageSource?: SandboxImageSource;
  dockerfilePath?: string;
  containerPortOverride?: number;
  skipDefaultCommand?: boolean;
  /**
   * When `true`, destroy any pre-existing service with the same id
   * (including ones currently `ready`) before provisioning. Used by the
   * retry endpoint so the user can forcibly rebuild a service whose
   * container died silently, without having to delete it first.
   */
  forceRecreate?: boolean;
}
