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
  /**
   * Which git root this file belongs to, as a project-relative prefix
   * ('' / undefined = the main repo). Only set on the AGGREGATE status (the
   * explorer's project-wide view that merges submodules + nested repos); a
   * single-repo status (Git tool window with an explicit repoPath) omits it.
   */
  repo?: string;
}

export interface GitStatus {
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  files?: GitStatusFile[];
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
 * In-progress conflict state. The first four are git sequencer ops
 * (exactly one mid-flight at a time, detected by its gitdir state file).
 * `'working-tree'` is the fallback for unmerged files with NO sequencer op
 * — e.g. a `git stash pop`/`apply` that conflicted: there's no
 * `<kind> --continue`, so the UI hides Continue and "abort" just discards
 * the conflicted files back to HEAD.
 */
export type MergeKind = 'merge' | 'cherry-pick' | 'revert' | 'rebase' | 'working-tree';

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

/**
 * Opt-in performance accelerators for the project's repo. `untrackedCache`
 * is a safe local cache (`.git/index.uc`, no daemon); `fsmonitor` enables
 * git's built-in file-system-monitor daemon (huge `status` speedup on big
 * repos, but a background process). Both are off unless the user enables
 * them and are fully reversible.
 */
export interface GitOptimizations {
  untrackedCache: boolean;
  fsmonitor: boolean;
  /** Resolved git version string (e.g. "2.45.1"). */
  gitVersion: string;
  /** Whether the installed git ships the built-in fsmonitor daemon (≥ 2.37). */
  fsmonitorSupported: boolean;
}

/**
 * Common scope for every project-git call. `projectId` selects the project;
 * `repoPath` optionally narrows the operation to ONE git root within it — the
 * absolute path of a repo returned by `listRepos` (the main repo, a submodule,
 * or a nested repo). The Git tool window ALWAYS sends an explicit `repoPath`
 * (the main repo root when "main" is selected), so its file paths are
 * unambiguously relative to that repo. When `repoPath` is omitted, the
 * explorer/editor allow-list verbs (`baseline`, `diff`, `stageHunk`, `stage`,
 * `unstage`, `discard`) auto-route each path to its containing repo, and every
 * other verb falls back to the project's main repo.
 */
export interface GitScope {
  projectId: number;
  repoPath?: string;
}

/**
 * One git root discovered inside a project by `listRepos` — the main repo plus
 * its submodules and nested independent repos. `projectRelPrefix` is the POSIX
 * path of this repo's root relative to the project `root_path` ('' when the repo
 * IS the project root); it's how aggregate status rebases a repo's files to
 * project-relative paths. `initialized` is false for a declared-but-not-checked-
 * out submodule (no `.git` yet — git can't run inside it). `ignoredByParent`
 * flags a nested repo the parent `.gitignore`s (a vendored checkout) so
 * aggregate status can skip its noise.
 */
export interface GitRepoRef {
  /** Absolute path of the repo root. */
  absPath: string;
  /** POSIX path relative to the project root_path; '' when repo === project root. */
  projectRelPrefix: string;
  /** Display name (last path segment, or 'main' for the project's own repo). */
  name: string;
  kind: 'main' | 'submodule' | 'nested';
  /** False for a declared submodule that isn't checked out yet. */
  initialized: boolean;
  /** True for a nested repo the parent repo's .gitignore excludes. */
  ignoredByParent: boolean;
}

export interface ProjectGitApi {
  /**
   * Discover all git roots inside the project — the main repo plus its
   * submodules and nested independent repos — so the Git tool window can offer
   * a repo selector. Cheap + cached server-side; bounded scan (never descends
   * huge ignored trees). Returns just the main repo for an ordinary single-repo
   * project.
   */
  listRepos(input: { projectId: number }, ctx: ApiContext): Promise<GitRepoRef[]>;

  status(input: GitScope & { includeFiles?: boolean }, ctx: ApiContext): Promise<GitStatus>;

  diff(
    input: GitScope & { path?: string; staged?: boolean },
    ctx: ApiContext,
  ): Promise<GitDiffResult>;

  /**
   * The committed (HEAD) content of one file — the baseline the editor's
   * change markers diff the live buffer against. `isRepo` is false when the
   * project isn't a git repo (no markers at all); when true, `content` null
   * means the file isn't at HEAD yet (new / untracked) and the gutter treats
   * the whole file as added.
   */
  baseline(
    input: GitScope & { path: string },
    ctx: ApiContext,
  ): Promise<{ content: string | null; isRepo: boolean }>;

  /**
   * Stage just the part of a file's working-tree changes that overlaps the
   * line range `[newStart, newEnd]` (1-based, on the working-tree/new side) —
   * the partial-hunk staging behind the gutter "stage/commit this block"
   * action. The file must already be flushed to disk. Builds a patch from
   * `git diff` (worktree↔index), keeps the overlapping hunks, and
   * `git apply --cached`s it. Throws 409 when the hunk no longer applies.
   */
  stageHunk(
    input: GitScope & { path: string; newStart: number; newEnd: number },
    ctx: ApiContext,
  ): Promise<{ ok: true; repoPath?: string }>;

  log(
    input: GitScope & { limit?: number; path?: string; branch?: string },
    ctx: ApiContext,
  ): Promise<GitCommit[]>;

  /**
   * Full detail of a single commit — metadata + message body + the list
   * of files it touched (with status + numstat). Powers the commit
   * preview panel in the Git log surface.
   */
  commitDetail(
    input: GitScope & { sha: string },
    ctx: ApiContext,
  ): Promise<GitCommitDetail>;

  /**
   * Unified diff of one file as introduced by a commit
   * (`git show <sha> -- <path>`). Used when the user clicks a changed
   * file in the commit preview — opens as a normal diff tab.
   */
  commitFileDiff(
    input: GitScope & { sha: string; path: string },
    ctx: ApiContext,
  ): Promise<GitDiffResult>;

  /**
   * Diff another branch against the current one. `worktree` → `git diff
   * <branch>` (branch vs working tree, "Show diff with working tree");
   * otherwise `git diff HEAD...<branch>` (symmetric from the merge-base,
   * "Compare with current"). Opens as a normal diff tab.
   */
  branchDiff(
    input: GitScope & { branch: string; worktree?: boolean },
    ctx: ApiContext,
  ): Promise<GitDiffResult>;

  stage(input: GitScope & { paths: string[] }, ctx: ApiContext): Promise<{ ok: true }>;
  unstage(input: GitScope & { paths: string[] }, ctx: ApiContext): Promise<{ ok: true }>;
  discard(input: GitScope & { paths: string[] }, ctx: ApiContext): Promise<{ ok: true }>;

  commit(
    input: GitScope & { message: string; amend?: boolean },
    ctx: ApiContext,
  ): Promise<{ sha: string }>;

  branchList(input: GitScope, ctx: ApiContext): Promise<{ current: string | null; all: string[] }>;
  branchCheckout(
    input: GitScope & { name: string; create?: boolean },
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
    input: GitScope & {
      includeRemote?: boolean;
      /**
       * Cache token — the caller's current git-revision. The handler caches
       * the (expensive on big repos) `for-each-ref` result per
       * (project, includeRemote, rev); same rev → cached, no git spawn; a new
       * rev (a checkout/commit/fetch moved a ref) recomputes. Omit to always
       * recompute.
       */
      rev?: number;
    },
    ctx: ApiContext,
  ): Promise<GitBranch[]>;

  branchCreate(
    input: GitScope & { name: string; from?: string; checkout?: boolean },
    ctx: ApiContext,
  ): Promise<{ ok: true }>;

  branchDelete(
    input: GitScope & { name: string; force?: boolean },
    ctx: ApiContext,
  ): Promise<{ ok: true }>;

  /** Rename a local branch (`git branch -m [--force] <old> <new>`). */
  branchRename(
    input: GitScope & { oldName: string; newName: string; force?: boolean },
    ctx: ApiContext,
  ): Promise<{ ok: true }>;

  // ── History-rewriting / merge ops ──────────────────────────
  merge(
    input: GitScope & { branch: string; ffOnly?: boolean; noFf?: boolean; message?: string },
    ctx: ApiContext,
  ): Promise<GitRunResult>;

  /**
   * Rebase the current branch onto another ref (`git rebase <onto>`). Runs
   * non-interactively (editor suppressed) so it can't hang; a conflict stops
   * the rebase and is surfaced through `mergeState` (kind `'rebase'`), where
   * the existing resolver + `mergeContinue`/`mergeAbort` take over.
   */
  rebase(
    input: GitScope & { onto: string },
    ctx: ApiContext,
  ): Promise<GitRunResult>;

  reset(
    input: GitScope & { target: string; mode: 'soft' | 'mixed' | 'hard' },
    ctx: ApiContext,
  ): Promise<GitRunResult>;

  revert(
    input: GitScope & { commit: string; noCommit?: boolean },
    ctx: ApiContext,
  ): Promise<GitRunResult>;

  cherryPick(
    input: GitScope & { commits: string[]; noCommit?: boolean },
    ctx: ApiContext,
  ): Promise<GitRunResult>;

  // ── Conflict resolution ────────────────────────────────────
  /**
   * Detect an in-progress sequencer op (merge / cherry-pick / revert /
   * rebase) and the files it left conflicted. Returns `kind: null` on a
   * clean tree. Powers the resolver banner + Conflicts tab. Cheap — a
   * couple of `git rev-parse`/`diff` calls.
   */
  mergeState(input: GitScope, ctx: ApiContext): Promise<GitMergeState>;

  /**
   * The three index stages + working-tree text of one conflicted file.
   * Seeds the 3-pane merge editor (ours / theirs panes) and gates the
   * inline editor for binary files.
   */
  conflictFile(
    input: GitScope & { path: string },
    ctx: ApiContext,
  ): Promise<GitConflictFile>;

  /**
   * Resolve one conflicted file and stage it. `'ours'`/`'theirs'` run
   * `git checkout --ours/--theirs` then `git add`; `{ content }` writes
   * the merged text then `git add`. Throws on binary `{ content }`.
   */
  resolveConflict(
    input: GitScope & { path: string; resolution: ConflictResolution },
    ctx: ApiContext,
  ): Promise<{ ok: true }>;

  /**
   * Finish the in-progress op (`<kind> --continue`) once every conflict
   * is staged. Runs non-interactively (the commit-message editor is
   * suppressed) so it can never hang. Refuses (409) while unmerged files
   * remain. Returns the rich GitRunResult on failure.
   */
  mergeContinue(input: GitScope, ctx: ApiContext): Promise<GitRunResult>;

  /** Abort the in-progress op (`<kind> --abort`), restoring pre-op state. */
  mergeAbort(input: GitScope, ctx: ApiContext): Promise<GitRunResult>;

  // ── Performance ────────────────────────────────────────────
  /**
   * Read the repo's performance-related config (core.untrackedCache /
   * core.fsmonitor) plus the git version and fsmonitor support. Powers the
   * "Git performance" toggles' current state.
   */
  gitOptimizations(input: GitScope, ctx: ApiContext): Promise<GitOptimizations>;

  /**
   * Enable/disable the repo's accelerators (writes `.git/config`). Omitted
   * fields are left unchanged. `fsmonitor` also starts/stops the built-in
   * daemon. Returns the fresh state. Reversible; only ever called from an
   * explicit user toggle.
   */
  configureGitOptimizations(
    input: GitScope & { untrackedCache?: boolean; fsmonitor?: boolean },
    ctx: ApiContext,
  ): Promise<GitOptimizations>;

  // ── Remote sync ────────────────────────────────────────────
  /**
   * Push the current (or given) branch to remote. `setUpstream: true`
   * publishes the local branch when it doesn't yet track a remote ref
   * (equivalent to `git push -u`). Forced pushes use `--force-with-lease`
   * defensively — never `--force` — so a stale ref errors out instead
   * of silently overwriting someone else's commits.
   */
  push(
    input: GitScope & {
      remote?: string;
      branch?: string;
      force?: boolean;
      setUpstream?: boolean;
    },
    ctx: ApiContext,
  ): Promise<GitRunResult>;

  /** Fetch refs from a remote. `prune: true` removes stale tracking refs. */
  fetch(
    input: GitScope & { remote?: string; prune?: boolean },
    ctx: ApiContext,
  ): Promise<GitRunResult>;

  /**
   * Pull from a remote into the current branch. `rebase: true` runs
   * `git pull --rebase` (the JetBrains "Update Project" default) which
   * keeps history linear when there's nothing local to merge.
   */
  pull(
    input: GitScope & { remote?: string; branch?: string; rebase?: boolean },
    ctx: ApiContext,
  ): Promise<GitRunResult>;

  /**
   * Fast-forward a NON-current local branch to its tracking upstream WITHOUT
   * checking it out (`git fetch <remote> <src>:<branch>`). Refuses a
   * non-fast-forward (diverged) update — the stderr is surfaced. The current
   * branch is updated with `pull` instead (git won't fetch into a checked-out
   * ref). Powers the branch menu's "Update" for non-current branches.
   */
  updateBranch(
    input: GitScope & { branch: string },
    ctx: ApiContext,
  ): Promise<GitRunResult>;

  // ── Stash ──────────────────────────────────────────────────
  /** List all stashes in the repo (newest first). Empty array when none. */
  stashList(input: GitScope, ctx: ApiContext): Promise<GitStashEntry[]>;

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
    input: GitScope & {
      message?: string;
      includeUntracked?: boolean;
      keepIndex?: boolean;
    },
    ctx: ApiContext,
  ): Promise<GitRunResult>;

  /** Apply `ref` and remove it from the stash list (`git stash pop`). */
  stashPop(input: GitScope & { ref: string }, ctx: ApiContext): Promise<GitRunResult>;

  /** Apply `ref` without removing it (`git stash apply`). */
  stashApply(input: GitScope & { ref: string }, ctx: ApiContext): Promise<GitRunResult>;

  /** Delete `ref` from the stash list (`git stash drop`). */
  stashDrop(input: GitScope & { ref: string }, ctx: ApiContext): Promise<GitRunResult>;

  /** Unified diff of `ref` against its parent — for the "view" action. */
  stashShow(input: GitScope & { ref: string }, ctx: ApiContext): Promise<GitDiffResult>;

  /**
   * Metadata + changed-file list for a stash entry. Powers the stash
   * preview surface (file list → click to open each file's diff),
   * mirroring `commitDetail` for commits.
   */
  stashDetail(input: GitScope & { ref: string }, ctx: ApiContext): Promise<GitStashDetail>;

  /** Unified diff of one file within a stash (`git stash show -p <ref> -- <path>`). */
  stashFileDiff(
    input: GitScope & { ref: string; path: string },
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
    input: GitScope & { intent: string },
    ctx: ApiContext,
  ): Promise<GitPlan>;

  /**
   * Execute a sequence of git steps, stopping at the first failure.
   * Steps come from an `aiPlan` the user reviewed and approved — we
   * still re-validate that every step's `command` is `git` (no shell
   * escapes) before spawning.
   */
  aiExecute(
    input: GitScope & { steps: GitPlanStep[] },
    ctx: ApiContext,
  ): Promise<{ results: GitRunResult[]; aborted: boolean }>;

  /**
   * Generate a Conventional-Commits message from the staged diff using
   * the project's general AI provider. Powers the Git panel's inline
   * commit box "generate" button. Throws 412 when no general AI is
   * configured so the UI can point the user at Admin → AI Geral.
   */
  aiCommitMessage(
    input: GitScope,
    ctx: ApiContext,
  ): Promise<{ message: string }>;

  /**
   * Detect the project's `origin` remote URL + default branch (best-effort).
   * Powers the cloud project-library pointer (P6-C). Returns nulls for a non-git
   * project or when no `origin` remote is configured. On-demand only (NOT called
   * on project open) to avoid a per-open git spawn.
   */
  detectRemote(input: GitScope): Promise<{ gitRemote: string | null; defaultBranch: string | null }>;
}
