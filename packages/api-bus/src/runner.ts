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

export type RunnerManager = 'npm' | 'yarn' | 'pnpm' | 'bun' | 'composer' | 'gradle' | 'maven' | 'dotnet';

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
}

export interface RunnerApi {
  /** Scan the project's root for runnable commands across ecosystems. */
  detect(input: { projectId: number }, ctx: ApiContext): Promise<DetectedRunners>;

  /** Spawn a command as a tracked run; returns its task + PTY ids. */
  start(input: RunnerStartInput, ctx: ApiContext): Promise<RunnerTask>;

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
