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

/** A single file touched by a commit (from `git show --numstat --name-status`). */
export interface GitCommitFileChange {
  path: string;
  /** Previous path for renames/copies; undefined otherwise. */
  oldPath?: string;
  state: 'modified' | 'added' | 'deleted' | 'renamed' | 'copied';
  /** Lines added/removed; 0 for binary files (git emits `-`). */
  additions: number;
  deletions: number;
}

/** Full detail of one commit — powers the IDE's commit preview panel. */
export interface GitCommitDetail {
  sha: string;
  shortSha: string;
  author: string;
  authorEmail: string;
  date: string;
  subject: string;
  /** Commit message body (everything after the subject line). */
  body: string;
  /** Parent SHAs (2+ for merge commits, 0 for the root commit). */
  parents: string[];
  files: GitCommitFileChange[];
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
 * Single entry from `git stash list`. The frontend renders these in the
 * Stash tab with pop/apply/drop/diff actions. `index` is the stable
 * position from `stash list --format=%gd` (e.g. `stash@{0}`) — used as
 * the ref for subsequent stash sub-commands. `name` is the short label
 * extracted from the description ("WIP on branch: ..." → "WIP on branch").
 */
export interface GitStashEntry {
  /** Stash ref — exact string passed to pop/apply/drop (e.g. `stash@{0}`). */
  index: string;
  /** Short SHA of the stash commit. */
  shortSha: string;
  /** Branch the stash was created on (parsed from the auto-generated message). */
  branch: string | null;
  /** User-provided message, or the auto "WIP on <branch>: <sha> <subject>". */
  message: string;
  /** ISO-strict date when the stash was created. */
  date: string;
}

/** Full detail of a stash entry — powers the stash preview surface. */
export interface GitStashDetail {
  /** Stash ref (e.g. `stash@{0}`). */
  ref: string;
  shortSha: string;
  /** Branch the stash was created on, when parseable. */
  branch: string | null;
  message: string;
  date: string;
  files: GitCommitFileChange[];
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

/**
 * In-progress sequencer operation. git lets exactly one of merge /
 * cherry-pick / revert / rebase be mid-flight at a time; we detect which
 * by stat-ing its state file under the gitdir.
 */
export type MergeKind = 'merge' | 'cherry-pick' | 'revert' | 'rebase';

/**
 * Snapshot of "are we stuck mid-merge?" state — drives the conflict
 * resolver UI (banner + Conflicts tab). `kind` is null when the working
 * tree is clean of any in-progress sequencer op.
 */
export interface GitMergeState {
  kind: MergeKind | null;
  /** Unmerged (conflicted) paths, repoRoot-relative posix. */
  conflictedFiles: string[];
  /** Label for "our" side — the current branch, or 'HEAD (detached)'. */
  oursLabel: string;
  /** Label for the incoming side — incoming subject, else short sha. */
  theirsLabel: string;
  /** Subject line of the incoming commit, when resolvable. */
  incomingSubject?: string;
  /** Sha of the incoming commit (from CHERRY_PICK_HEAD / MERGE_HEAD / …). */
  incomingSha?: string;
}

/**
 * The three index stages of one conflicted file plus the working-tree
 * text (which carries git's `<<<<<<<` markers). A stage is null when it
 * doesn't exist for this conflict (add/add has no base; modify/delete is
 * missing ours or theirs). When `binary` the UI must offer only
 * ours/theirs — there's no sensible text merge.
 */
export interface GitConflictFile {
  /** Common ancestor (`:1:path`), or null (add/add). */
  base: string | null;
  /** Our side (`:2:path`), or null when our side deleted it. */
  ours: string | null;
  /** Their side (`:3:path`), or null when their side deleted it. */
  theirs: string | null;
  /** Working-tree contents WITH conflict markers; '' when the file is gone. */
  merged: string;
  hasOurs: boolean;
  hasTheirs: boolean;
  binary: boolean;
  /** Best-effort language id (derived from extension), when known. */
  language?: string;
}

/**
 * How to resolve one conflicted file: take a whole side, or write
 * explicit merged content. String sides run `git checkout --ours/--theirs`;
 * `{ content }` writes the file then stages it.
 */
export type ConflictResolution = 'ours' | 'theirs' | { content: string };

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

  /**
   * Full detail of a single commit — metadata + message body + the list
   * of files it touched (with status + numstat). Powers the commit
   * preview panel in the Git log surface.
   */
  commitDetail(
    input: { projectId: number; sha: string },
    ctx: ApiContext,
  ): Promise<GitCommitDetail>;

  /**
   * Unified diff of one file as introduced by a commit
   * (`git show <sha> -- <path>`). Used when the user clicks a changed
   * file in the commit preview — opens as a normal diff tab.
   */
  commitFileDiff(
    input: { projectId: number; sha: string; path: string },
    ctx: ApiContext,
  ): Promise<GitDiffResult>;

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

  /** Rename a local branch (`git branch -m [--force] <old> <new>`). */
  branchRename(
    input: { projectId: number; oldName: string; newName: string; force?: boolean },
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

  // ── Conflict resolution ────────────────────────────────────
  /**
   * Detect an in-progress sequencer op (merge / cherry-pick / revert /
   * rebase) and the files it left conflicted. Returns `kind: null` on a
   * clean tree. Powers the resolver banner + Conflicts tab. Cheap — a
   * couple of `git rev-parse`/`diff` calls.
   */
  mergeState(input: { projectId: number }, ctx: ApiContext): Promise<GitMergeState>;

  /**
   * The three index stages + working-tree text of one conflicted file.
   * Seeds the 3-pane merge editor (ours / theirs panes) and gates the
   * inline editor for binary files.
   */
  conflictFile(
    input: { projectId: number; path: string },
    ctx: ApiContext,
  ): Promise<GitConflictFile>;

  /**
   * Resolve one conflicted file and stage it. `'ours'`/`'theirs'` run
   * `git checkout --ours/--theirs` then `git add`; `{ content }` writes
   * the merged text then `git add`. Throws on binary `{ content }`.
   */
  resolveConflict(
    input: { projectId: number; path: string; resolution: ConflictResolution },
    ctx: ApiContext,
  ): Promise<{ ok: true }>;

  /**
   * Finish the in-progress op (`<kind> --continue`) once every conflict
   * is staged. Runs non-interactively (the commit-message editor is
   * suppressed) so it can never hang. Refuses (409) while unmerged files
   * remain. Returns the rich GitRunResult on failure.
   */
  mergeContinue(input: { projectId: number }, ctx: ApiContext): Promise<GitRunResult>;

  /** Abort the in-progress op (`<kind> --abort`), restoring pre-op state. */
  mergeAbort(input: { projectId: number }, ctx: ApiContext): Promise<GitRunResult>;

  // ── Remote sync ────────────────────────────────────────────
  /**
   * Push the current (or given) branch to remote. `setUpstream: true`
   * publishes the local branch when it doesn't yet track a remote ref
   * (equivalent to `git push -u`). Forced pushes use `--force-with-lease`
   * defensively — never `--force` — so a stale ref errors out instead
   * of silently overwriting someone else's commits.
   */
  push(
    input: {
      projectId: number;
      remote?: string;
      branch?: string;
      force?: boolean;
      setUpstream?: boolean;
    },
    ctx: ApiContext,
  ): Promise<GitRunResult>;

  /** Fetch refs from a remote. `prune: true` removes stale tracking refs. */
  fetch(
    input: { projectId: number; remote?: string; prune?: boolean },
    ctx: ApiContext,
  ): Promise<GitRunResult>;

  /**
   * Pull from a remote into the current branch. `rebase: true` runs
   * `git pull --rebase` (the JetBrains "Update Project" default) which
   * keeps history linear when there's nothing local to merge.
   */
  pull(
    input: { projectId: number; remote?: string; branch?: string; rebase?: boolean },
    ctx: ApiContext,
  ): Promise<GitRunResult>;

  // ── Stash ──────────────────────────────────────────────────
  /** List all stashes in the repo (newest first). Empty array when none. */
  stashList(input: { projectId: number }, ctx: ApiContext): Promise<GitStashEntry[]>;

  /**
   * Create a new stash from the current working tree.
   *
   *   - `message`: optional human label (`git stash push -m <message>`).
   *   - `includeUntracked`: when true, includes untracked files
   *     (`--include-untracked` / `-u`). Defaults to false; matches `git
   *     stash` CLI default to avoid surprising the user with files they
   *     didn't think to track.
   *   - `keepIndex`: when true, leaves the index intact (`--keep-index`),
   *     useful for "stash everything except what I'm about to commit".
   */
  stashSave(
    input: {
      projectId: number;
      message?: string;
      includeUntracked?: boolean;
      keepIndex?: boolean;
    },
    ctx: ApiContext,
  ): Promise<GitRunResult>;

  /** Apply `ref` and remove it from the stash list (`git stash pop`). */
  stashPop(input: { projectId: number; ref: string }, ctx: ApiContext): Promise<GitRunResult>;

  /** Apply `ref` without removing it (`git stash apply`). */
  stashApply(input: { projectId: number; ref: string }, ctx: ApiContext): Promise<GitRunResult>;

  /** Delete `ref` from the stash list (`git stash drop`). */
  stashDrop(input: { projectId: number; ref: string }, ctx: ApiContext): Promise<GitRunResult>;

  /** Unified diff of `ref` against its parent — for the "view" action. */
  stashShow(input: { projectId: number; ref: string }, ctx: ApiContext): Promise<GitDiffResult>;

  /**
   * Metadata + changed-file list for a stash entry. Powers the stash
   * preview surface (file list → click to open each file's diff),
   * mirroring `commitDetail` for commits.
   */
  stashDetail(input: { projectId: number; ref: string }, ctx: ApiContext): Promise<GitStashDetail>;

  /** Unified diff of one file within a stash (`git stash show -p <ref> -- <path>`). */
  stashFileDiff(
    input: { projectId: number; ref: string; path: string },
    ctx: ApiContext,
  ): Promise<GitDiffResult>;

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

  /**
   * Generate a Conventional-Commits message from the staged diff using
   * the project's general AI provider. Powers the Git panel's inline
   * commit box "generate" button. Throws 412 when no general AI is
   * configured so the UI can point the user at Admin → AI Geral.
   */
  aiCommitMessage(
    input: { projectId: number },
    ctx: ApiContext,
  ): Promise<{ message: string }>;
}
