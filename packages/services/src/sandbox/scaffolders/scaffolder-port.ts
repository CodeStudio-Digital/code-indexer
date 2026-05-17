/**
 * Scaffolder port — bootstraps a fresh project inside a running sandbox.
 *
 * Each stack (React+Vite, Vue+Vite, Laravel, Django, …) ships an
 * implementation. Adding a stack is a closed-open operation: no existing
 * scaffolder changes, no conditional logic grows anywhere else.
 *
 * Responsibilities:
 *   - Run the stack's official scaffolding command inside the container
 *     (e.g. `npm create vite@latest app -- --template react-ts`).
 *   - Write any dev-server config required to make the preview iframe
 *     work behind the API's `/preview/:sessionId/*` reverse proxy (for
 *     Vite: `base` + `server.hmr.clientPort`/`path`).
 *   - Install deps and spawn the dev server in the background.
 *
 * The scaffolder does NOT own the container lifecycle — that belongs to
 * `SandboxManager`. It receives an already-running container handle and
 * the driver to talk to it.
 */

import type { ISandboxDriver } from '../ports/sandbox-driver.js';
import type { SandboxEvent, SandboxStack } from '../types.js';

export interface ScaffoldContext {
  sandboxId: string;
  containerId: string;
  /** Absolute container path where the project should live, e.g. `/app`. */
  workdir: string;
  /** Container-internal port the dev server must listen on. */
  devServerPort: number;
  /** Public URL the iframe will use — scaffolders may need this to
   *  configure HMR behind the proxy (Vite `server.hmr.clientPort` etc). */
  previewUrl: string;
  /** Path prefix applied by the API proxy (e.g. `/preview/<sessionId>/`).
   *  Vite's `base` config must match this or asset URLs break. */
  previewPathPrefix: string;
  driver: ISandboxDriver;
  signal?: AbortSignal;
  /**
   * Per-session opt-in for the Playwright Agent CLI bootstrap. When set,
   * scaffolders should prefer this over their construct-time `includeE2e`
   * — the runtime context (driven by `role_assignments` of the session)
   * is the source of truth, not the registry's compile-time default.
   */
  includeE2e?: boolean;
  /** Emit progress / log events up to the manager (and through to SSE). */
  emit: (event: SandboxEvent) => void;
}

export interface IScaffolder {
  readonly stack: SandboxStack;
  /**
   * Populate `ctx.workdir` and start the dev server. MUST resolve only
   * when the dev server is ready to accept connections on
   * `ctx.devServerPort` (or throw if provisioning failed).
   */
  scaffold(ctx: ScaffoldContext): Promise<void>;
}
