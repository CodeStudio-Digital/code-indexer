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

export interface ProjectGitApi {
  status(input: { projectId: number }, ctx: ApiContext): Promise<GitStatus>;

  diff(
    input: { projectId: number; path?: string; staged?: boolean },
    ctx: ApiContext,
  ): Promise<GitDiffResult>;

  log(
    input: { projectId: number; limit?: number; path?: string },
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
}
