/**
 * Host-template contract. A template declares its identity and emits an
 * ordered list of `HostStep`s (CLI invocations) that scaffold the project
 * into `ctx.targetDir`. The runner executes the steps in order, streaming
 * logs, and registers the result only after all steps succeed.
 *
 * Templates mirror the command sequences of the container scaffolders in
 * `../../sandbox/scaffolders/` but run on the host with no container.
 */

export type TemplateId =
  | 'react-vite'
  | 'vue'
  | 'angular'
  | 'vite-api'
  | 'cf-worker'
  | 'nextjs'
  | 'opennext-cf'
  | 'vite-react-cf'
  | 'git-clone'
  | 'empty';

export interface HostStep {
  /** Coarse phase label surfaced to the UI. */
  phase: 'run-cli' | 'install-deps' | 'git-init' | 'configure';
  program: string;
  args: string[];
  /**
   * Working directory for THIS step. Many create-CLIs must run in the
   * PARENT of the target (they create the slug dir themselves); install
   * steps run INSIDE the target. The runner resolves `'parent'` to the
   * target's parent and `'target'` to the target itself.
   */
  cwd: 'parent' | 'target';
  timeoutMs: number;
  /** Human-readable description for the `phase` SSE event. */
  label: string;
}

export interface BuildStepsContext {
  /** Collision-resolved folder name (safe for the shell). */
  slug: string;
  /** Absolute path to the project dir (`<root>/<slug>`). */
  targetDir: string;
  /** Validated repo URL — present only for `git-clone`. */
  repoUrl?: string;
  /** Whether to run `git init` on an `empty` project. */
  gitInit?: boolean;
}

export interface HostTemplate {
  id: TemplateId;
  /** True if the template needs the npm registry / a git remote. */
  needsNetwork: boolean;
  /** True if `repoUrl` is required (git-clone). */
  requiresRepoUrl?: boolean;
  /** Whether the runner must `mkdir` the target before the first step. */
  createsTargetDir: boolean;
  files?(ctx: BuildStepsContext): Record<string, string>;
  build(ctx: BuildStepsContext): HostStep[];
}

// Shared timeouts — install/clone are slow; match container scaffolders.
export const INSTALL_TIMEOUT_MS = 300_000;
export const CLI_TIMEOUT_MS = 300_000;
export const QUICK_TIMEOUT_MS = 30_000;

/**
 * Env applied to every host step: force non-interactive CLIs and silence
 * the telemetry/analytics prompts that would otherwise block a non-TTY
 * child (`npm_config_yes` auto-confirms `npm create`'s install prompt;
 * Angular/Next telemetry prompts are disabled).
 */
export const NON_INTERACTIVE_ENV: NodeJS.ProcessEnv = {
  CI: '1',
  npm_config_yes: 'true',
  ADBLOCK: '1',
  NG_CLI_ANALYTICS: 'false',
  NEXT_TELEMETRY_DISABLED: '1',
  DO_NOT_TRACK: '1',
};
