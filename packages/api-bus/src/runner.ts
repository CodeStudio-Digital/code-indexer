import type { ApiContext, AsyncStream } from './common.js';

/**
 * Runner / task player — detects the runnable commands of a project
 * (npm/yarn/pnpm scripts, composer scripts, gradle/maven tasks, dotnet)
 * and runs them as long-lived PTYs in the main process. Because the PTYs
 * share the `terminal` namespace's registry, a run survives renderer
 * navigation and its colored output streams via `terminal.output`.
 *
 * No "pause": OS process suspend isn't portable (no SIGSTOP on Windows),
 * so the controls are Stop + Restart only.
 */

export type RunnerManager =
  | 'npm'
  | 'yarn'
  | 'pnpm'
  | 'bun'
  | 'composer'
  // Python package managers (project dependency assistant + detection).
  | 'pip'
  | 'poetry'
  | 'gradle'
  | 'maven'
  | 'dotnet'
  // Single-file runs launched from the editor gutter / "Run with" — the
  // runtime doubles as the manager tag (e.g. `php script.php`).
  | 'node'
  | 'php'
  | 'python'
  // Shell snippet runs (a ```bash/```sh block in a markdown file).
  | 'shell';

/** How to run a markdown fenced code block of a given language. */
export interface SnippetRun {
  /** Temp-file extension (no dot). */
  ext: string;
  /** Interpreter binary, e.g. `bash` / `php` / `python` / `node`. */
  bin: string;
  /** Runner manager tag (drives the icon/label in the Runners list). */
  manager: RunnerManager;
}

const SNIPPET_RUN: Record<string, SnippetRun> = {
  bash: { ext: 'sh', bin: 'bash', manager: 'shell' },
  sh: { ext: 'sh', bin: 'bash', manager: 'shell' },
  shell: { ext: 'sh', bin: 'bash', manager: 'shell' },
  php: { ext: 'php', bin: 'php', manager: 'php' },
  python: { ext: 'py', bin: 'python', manager: 'python' },
  py: { ext: 'py', bin: 'python', manager: 'python' },
  js: { ext: 'js', bin: 'node', manager: 'node' },
  javascript: { ext: 'js', bin: 'node', manager: 'node' },
  node: { ext: 'js', bin: 'node', manager: 'node' },
};

/**
 * Resolve a markdown fence language tag (```bash, ```php, ```py …) to how to
 * run it, or null when the language isn't runnable. Single source of truth for
 * the editor gutter (which languages get a ▶) and the runner backend (how to
 * materialise + run the snippet). `.ts`/typescript is intentionally absent
 * (needs a loader), mirroring the whole-file gutter.
 */
export function snippetRunFor(language: string | null | undefined): SnippetRun | null {
  if (!language) return null;
  return SNIPPET_RUN[language.toLowerCase().trim()] ?? null;
}

/** A single runnable command surfaced by detection. */
export interface DetectedRunner {
  /** Stable id within the project (e.g. "npm:dev", "maven:test"). */
  id: string;
  /** Human label (the script/task/goal name). */
  label: string;
  manager: RunnerManager;
  /** Full shell command, e.g. `pnpm run dev` or `dotnet watch`. */
  command: string;
}

/** Runners grouped by manager, plus an install hint per group. */
export interface DetectedGroup {
  manager: RunnerManager;
  /** Source file that produced this group (package.json, pom.xml, …). */
  source: string;
  runners: DetectedRunner[];
  /** True when dependencies appear to be missing (no node_modules/vendor). */
  installNeeded: boolean;
  /** Command to install deps, when applicable (e.g. `pnpm install`). */
  installCommand?: string;
}

export interface DetectedRunners {
  groups: DetectedGroup[];
}

export type RunnerStatus = 'running' | 'exited' | 'stopped';

/** A live (or recently finished) run tracked by the registry. */
export interface RunnerTask {
  taskId: string;
  /** PTY id — feed to `terminal.output` to stream the log. */
  terminalId: string;
  projectId: number;
  projectName: string;
  label: string;
  command: string;
  manager: RunnerManager;
  /** Project-relative working dir the run was launched in (for restart). */
  cwd?: string;
  status: RunnerStatus;
  exitCode: number | null;
  /** Epoch ms when the run started. */
  startedAt: number;
}

export interface RunnerStartInput {
  projectId: number;
  command: string;
  label: string;
  manager: RunnerManager;
  /**
   * Project-relative working directory to run in (defaults to the project root).
   * Used by the run gutter for a NESTED package.json/composer.json so
   * `npm run`/`composer run` resolve the right manifest. Resolved + confined to
   * the project root server-side.
   */
  cwd?: string;
}

/** Whether a package-manager binary is available on the project's PATH. */
export interface ManagerStatus {
  found: boolean;
  version?: string;
}

export interface RunnerApi {
  /** Scan the project's root for runnable commands across ecosystems. */
  detect(input: { projectId: number }, ctx: ApiContext): Promise<DetectedRunners>;

  /**
   * Probe whether a package manager (npm/yarn/pnpm/bun/composer/pip/poetry) is
   * on the project's effective PATH — so the dependency assistant can warn
   * before an install would fail with "command not found".
   */
  managerStatus(
    input: { projectId: number; manager: RunnerManager },
    ctx: ApiContext,
  ): Promise<ManagerStatus>;

  /** Spawn a command as a tracked run; returns its task + PTY ids. */
  start(input: RunnerStartInput, ctx: ApiContext): Promise<RunnerTask>;

  /**
   * Run a markdown fenced code block: materialise `code` to a temp file and
   * execute it with the language's interpreter (the project's runtime PATH is
   * injected). The editor markdown gutter calls this. Rejects an unsupported
   * language.
   */
  runSnippet(
    input: { projectId: number; language: string; code: string; label: string },
    ctx: ApiContext,
  ): Promise<RunnerTask>;

  /** Kill a run's process and mark it stopped. */
  stop(input: { taskId: string }, ctx: ApiContext): Promise<void>;

  /**
   * Remove a finished run (exited/stopped) from the registry so it no
   * longer shows in the lists. Killing-then-removing a still-running run
   * is allowed too (the PTY is terminated first).
   */
  dismiss(input: { taskId: string }, ctx: ApiContext): Promise<void>;

  /** Kill + re-spawn with the same command/label. Returns the new task. */
  restart(input: { taskId: string }, ctx: ApiContext): Promise<RunnerTask>;

  /** All tracked runs across every project (for the global header). */
  list(_input: Record<string, never> | undefined, ctx: ApiContext): Promise<RunnerTask[]>;

  /** Emit the full task list on every lifecycle change (start/exit/stop). */
  events(_input: Record<string, never> | undefined, ctx: ApiContext): AsyncStream<RunnerTask[]>;
}
