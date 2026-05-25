import type { ApiContext } from './common.js';

/**
 * Git operations scoped to a project's local working tree. Distinct from
 * `workspace.git.*` (which targets a company-session sandbox container).
 * The IDE workspace's Git tool window hits these methods.
 *
 * Implementation is a thin wrapper over `git` CLI invoked at the
 * project's root_path — keeps us out of the dep weeds vs simple-git /
 * isomorphic-git.
 */

export interface GitStatusFile {
  path: string;
  state:
    | 'modified'
    | 'added'
    | 'deleted'
    | 'renamed'
    | 'copied'
    | 'untracked'
    | 'ignored'
    | 'unmerged';
  /** Whether the change is staged for commit. */
  staged: boolean;
}

export interface GitStatus {
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  files: GitStatusFile[];
  /** Repository root, or null when the project isn't a git repo. */
  repoRoot: string | null;
  /** True when `root_path` isn't a git repo at all. */
  notARepo: boolean;
}

export interface GitCommit {
  sha: string;
  shortSha: string;
  author: string;
  date: string;
  subject: string;
}

export interface GitDiffResult {
  /** Unified diff text. Empty string when there are no changes. */
  patch: string;
}

export interface GitBranch {
  /** Short name (e.g. `main`, `origin/feature/x`). */
  name: string;
  /** True for the currently-checked-out branch. */
  isCurrent: boolean;
  /** True for refs under `refs/remotes/`. */
  isRemote: boolean;
  /** Upstream branch name (e.g. `origin/main`) when configured. */
  upstream: string | null;
  /** Commits ahead/behind upstream when computable; 0 otherwise. */
  ahead: number;
  behind: number;
  /** Subject of the tip commit. */
  tipSubject: string;
}

/**
 * Output of a single git operation run via aiExecute. The frontend
 * uses `ok` to color the row and `output`/`stderr` to surface output.
 */
export interface GitRunResult {
  command: string;
  args: string[];
  ok: boolean;
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Step in an AI-generated git plan. The frontend renders these for
 * user review before calling `aiExecute`. Marking `dangerous` flips
 * the row to a warning style so the user thinks twice (e.g. reset
 * --hard, force push, branch delete).
 */
export interface GitPlanStep {
  command: string;
  args: string[];
  description: string;
  dangerous: boolean;
}

export interface GitPlan {
  intent: string;
  steps: GitPlanStep[];
  /** Human-readable summary the AI produced alongside the steps. */
  summary: string;
  /** When the AI refused (intent unclear / out of scope) this is set
   *  instead of `steps`. UI shows it as guidance. */
  refusal?: string;
}

export interface ProjectGitApi {
  status(input: { projectId: number }, ctx: ApiContext): Promise<GitStatus>;

  diff(
    input: { projectId: number; path?: string; staged?: boolean },
    ctx: ApiContext,
  ): Promise<GitDiffResult>;

  log(
    input: { projectId: number; limit?: number; path?: string; branch?: string },
    ctx: ApiContext,
  ): Promise<GitCommit[]>;

  stage(input: { projectId: number; paths: string[] }, ctx: ApiContext): Promise<{ ok: true }>;
  unstage(input: { projectId: number; paths: string[] }, ctx: ApiContext): Promise<{ ok: true }>;
  discard(input: { projectId: number; paths: string[] }, ctx: ApiContext): Promise<{ ok: true }>;

  commit(
    input: { projectId: number; message: string; amend?: boolean },
    ctx: ApiContext,
  ): Promise<{ sha: string }>;

  branchList(input: { projectId: number }, ctx: ApiContext): Promise<{ current: string | null; all: string[] }>;
  branchCheckout(
    input: { projectId: number; name: string; create?: boolean },
    ctx: ApiContext,
  ): Promise<{ ok: true }>;

  // ── Branch management ──────────────────────────────────────
  /**
   * Richer branch list — used by the IDE's Branches tab to render the
   * full picture (local + remote, upstream tracking, ahead/behind).
   * Distinct from `branchList` which returns name-only and is kept for
   * backwards compatibility with older callers.
   */
  branchesDetailed(
    input: { projectId: number; includeRemote?: boolean },
    ctx: ApiContext,
  ): Promise<GitBranch[]>;

  branchCreate(
    input: { projectId: number; name: string; from?: string; checkout?: boolean },
    ctx: ApiContext,
  ): Promise<{ ok: true }>;

  branchDelete(
    input: { projectId: number; name: string; force?: boolean },
    ctx: ApiContext,
  ): Promise<{ ok: true }>;

  // ── History-rewriting / merge ops ──────────────────────────
  merge(
    input: { projectId: number; branch: string; ffOnly?: boolean; noFf?: boolean; message?: string },
    ctx: ApiContext,
  ): Promise<GitRunResult>;

  reset(
    input: { projectId: number; target: string; mode: 'soft' | 'mixed' | 'hard' },
    ctx: ApiContext,
  ): Promise<GitRunResult>;

  revert(
    input: { projectId: number; commit: string; noCommit?: boolean },
    ctx: ApiContext,
  ): Promise<GitRunResult>;

  cherryPick(
    input: { projectId: number; commits: string[]; noCommit?: boolean },
    ctx: ApiContext,
  ): Promise<GitRunResult>;

  // ── AI-assisted git ────────────────────────────────────────
  /**
   * Generate a plan of git commands from a natural-language intent
   * using the project's general AI provider. Returns step list +
   * summary for user review. NEVER executes — `aiExecute` does that
   * after the user confirms.
   */
  aiPlan(
    input: { projectId: number; intent: string },
    ctx: ApiContext,
  ): Promise<GitPlan>;

  /**
   * Execute a sequence of git steps, stopping at the first failure.
   * Steps come from an `aiPlan` the user reviewed and approved — we
   * still re-validate that every step's `command` is `git` (no shell
   * escapes) before spawning.
   */
  aiExecute(
    input: { projectId: number; steps: GitPlanStep[] },
    ctx: ApiContext,
  ): Promise<{ results: GitRunResult[]; aborted: boolean }>;
}
