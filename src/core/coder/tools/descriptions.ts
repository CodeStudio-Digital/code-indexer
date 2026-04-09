/**
 * Central catalog of native tool descriptions.
 *
 * Keeping descriptions out of the handler files serves two goals:
 *   1. Tuning prompts is a single-file, single-diff change — no risk of
 *      touching tool logic by accident.
 *   2. Lets us apply terse-mode transforms (see CODER_TERSE_TOOLS) uniformly.
 *
 * To edit a description, modify the constant here. The handler imports it
 * by name. Do not add conditional logic or string concatenation that depends
 * on runtime state — these constants MUST be bit-stable to preserve the
 * server-side prompt cache.
 */

// ---------- filesystem (src/core/coder/tools/fs.ts) ----------
//
// Each description follows a USE / DON'T pattern inspired by opencode's tool
// prompts. The goal isn't documenting the API (the JSON schema already does
// that) — it's teaching the model to ROUTE correctly and avoid the common
// anti-patterns that waste tokens and produce bad edits. Keep the content
// bit-stable: never append runtime state.

export const WRITE_FILE_DESC =
  'Overwrite an existing file with new content. Creates parent directories if missing.\n' +
  "USE: replacing the entire contents of a file you have already read.\n" +
  "DON'T: create a new file (use create_file — write_file fails if the file is missing on some configs, and it's clearer intent).\n" +
  "DON'T: make a small targeted change (use edit_file — rewriting the whole file for a 2-line fix burns tokens and risks collateral damage).\n" +
  "DON'T: write without reading first. Always read_file / mcp__read_file / mcp__get_symbol_body BEFORE overwriting.";

export const CREATE_FILE_DESC =
  'Create a brand-new file. Fails cleanly if the path already exists.\n' +
  "USE: adding a new source file, test, or config.\n" +
  "DON'T: use this to replace an existing file — it will error. Use write_file for replacements.\n" +
  "DON'T: create placeholder/empty files speculatively. Create only when you have the final content ready.";

export const EDIT_FILE_DESC =
  'Find-and-replace edit on a file. Progressive matching: exact → normalized whitespace → indentation-flexible → block-anchor. Returns a fuzzy hint if no match.\n' +
  "USE: targeted change within a larger file — fixing a function, tweaking a config value, renaming a symbol in one place.\n" +
  "USE: replace_all=true when you genuinely want every occurrence replaced.\n" +
  "DON'T: retry the exact same old_string after a failure — READ the fuzzy hint, correct the snippet, then retry. Blind retries are the #1 cause of doom-loop aborts.\n" +
  "DON'T: supply an old_string that appears many times in the file unless replace_all=true — you'll get an ambiguity error.\n" +
  "DON'T: edit a file you haven't read this session — use mcp__get_symbol_body or read_file first.\n" +
  "DON'T: chain 3+ edit_file calls on the same file — use multi_edit instead (1 call, atomic rollback on failure).";

export const MULTI_EDIT_DESC =
  'Apply MULTIPLE sequential find/replace operations to ONE file atomically.\n' +
  'Uses the same cascading matcher as edit_file. Each op runs against the in-memory result of the previous ones; the file on disk is written once at the end only if every op succeeds.\n' +
  "USE: refactors that touch 2+ disjoint sections of the same file (rename a function + update its JSDoc + fix callers in the same module).\n" +
  "USE: when you already know all the changes up front — saves 2-4 turns vs chaining edit_file.\n" +
  "DON'T: use for edits across different files (run edit_file in parallel instead).\n" +
  "DON'T: use for a single edit — just call edit_file.\n" +
  "DON'T: retry the whole list blindly after an abort. Read the error, fix the specific edit that failed, then re-submit.\n" +
  'If ANY edit fails (not found, ambiguous without replace_all), nothing is written to disk — the file is untouched and the tool reports which op failed.';

export const READ_FILE_NATIVE_DESC =
  'Read a file from disk directly (bypasses the indexer). Default: first 400 lines.\n' +
  "USE: file you just created/modified that mcp__read_file says is unknown (session overlay covers the common case, but this is the fallback).\n" +
  "USE: quick sanity-check of a config/dotfile that the indexer skipped.\n" +
  "DON'T: use as your default reader. Prefer mcp__read_file (overlay-aware) or mcp__get_symbol_body (outputs only the function you need, ~10x cheaper).\n" +
  "DON'T: read a 2000-line file when you only need one symbol — use mcp__get_file_skeleton to find the symbol first, then mcp__get_symbol_body.";

export const LIST_DIRECTORY_NATIVE_DESC =
  'List files and subdirectories at a path (non-recursive). Fallback path when the indexer listing is stale.\n' +
  "USE: a directory you just created files in and mcp__list_directory still shows the stale version.\n" +
  "DON'T: use as your default lister. mcp__list_directory is overlay-aware and cheaper.\n" +
  "DON'T: walk the tree by recursive listing. Use mcp__grep_code with a glob filter for fan-out searches.";

// ---------- git (src/core/coder/tools/git.ts) ----------

export const GIT_STATUS_DESC =
  'Show working tree status (git status --short).\n' +
  "USE: before committing, or to verify what the user's latest changes touched.\n" +
  "DON'T: run this every turn as a sanity check — git state rarely changes between your own tool calls.";

export const GIT_DIFF_DESC =
  "Show working tree diff. Pass `staged: true` for the staged diff.\n" +
  "USE: reviewing what you (or the user) are about to commit.\n" +
  "USE: answering 'what changed?' questions about uncommitted work.\n" +
  "DON'T: diff a whole repo to understand history — use git_log for that.";

export const GIT_LOG_DESC =
  'Show recent commit history (default last 10).\n' +
  "USE: understanding recent intent/decisions, finding when a change was introduced.\n" +
  "DON'T: use as a substitute for reading the code — log messages lie, code doesn't.";

export const GIT_ADD_DESC =
  'Stage files for commit. Pass an array of specific paths.\n' +
  "USE: staging the files you intentionally changed, by explicit name.\n" +
  "DON'T: pass '.' or '-A' — you'll accidentally stage untracked noise, secrets, or the user's work-in-progress. Always list paths.";

export const GIT_COMMIT_DESC =
  "Create a commit from staged changes. Always include a clear 'why' in the message.\n" +
  "USE: only when the user explicitly asked to commit. This is admin-tier and requires expand_toolset first.\n" +
  "DON'T: commit speculatively after an edit. The user reviews diffs themselves.\n" +
  "DON'T: use --no-verify or amend unless the user explicitly asked.";

export const GIT_BRANCH_DESC =
  'List branches or show the current branch.\n' +
  "USE: verifying which branch you're on before committing or creating a PR.\n" +
  "DON'T: create/delete branches without user permission — this tool is read-only by default; pass name to create.";

// ---------- shell (src/core/coder/tools/shell.ts) ----------

export const RUN_COMMAND_DESC =
  'Execute a shell command in the project root. Default timeout 120s. Returns stdout, stderr, exit code.\n' +
  "USE: running tests, builds, linters, formatters, type checks — the kinds of things that verify your work.\n" +
  "USE: shell one-liners for which there is no dedicated tool (tar, curl against localhost, etc.).\n" +
  "DON'T: use cat/head/tail/less to read files — use read_file or mcp__read_file.\n" +
  "DON'T: use grep/rg/ack — use mcp__grep_code (indexer-aware, cheaper, filterable by layer/language).\n" +
  "DON'T: use find/ls for exploration — use mcp__list_directory or mcp__search.\n" +
  "DON'T: use sed/awk to edit files — use edit_file.\n" +
  "DON'T: run interactive commands that expect stdin (nano, vim, prompts). They'll hang and time out.\n" +
  "DON'T: run long-running servers in foreground (npm run dev). They'll block for 120s then abort.";

// ---------- interaction (src/core/coder/tools/interaction.ts) ----------

export const ASK_USER_DESC =
  'Pause and ask the user a question. Supports free-form answers or button options.\n' +
  "USE: when you need a decision/preference the user alone can make (which of 3 libraries, scope of refactor, naming).\n" +
  "USE: when critical context is missing and guessing would waste work.\n" +
  "DON'T: ask things you can verify yourself (file existence, type signatures, config values — READ them).\n" +
  "DON'T: ask for confirmation of obvious next steps ('should I now run the tests?'). Just do it.\n" +
  "DON'T: ask multiple small questions in sequence. Batch them into one question with options or a multi-line prompt.";

// ---------- plan (src/core/coder/tools/plan.ts) ----------

export const SUBMIT_PLAN_DESC =
  'Submit an implementation plan and wait for user approval. Returns the verdict (approved/rejected) and optional feedback.\n' +
  "USE: in plan mode, BEFORE any mutating tool. No exceptions.\n" +
  "USE: for linear, single-action work (one refactor, one bugfix, one feature). For 2+ independent items use submit_tasks instead.\n" +
  "DON'T: submit a plan that reads 'I will look at the code and decide' — do the exploration FIRST, then submit a concrete plan.\n" +
  "DON'T: try to skip the plan with a direct edit. Mutating tools are blocked until the plan is approved.\n" +
  "DON'T: re-submit a rejected plan with cosmetic tweaks — read the feedback and actually address it.";

// ---------- tasks (src/core/coder/tools/tasks.ts) ----------

export const SUBMIT_TASKS_DESC =
  'Submit a STRUCTURED task list and wait for user approval. Returns the (possibly-edited) tasks and chosen execution mode.\n' +
  "USE: when the work decomposes into 2+ independent items (refactors touching many files, multi-area fixes, migrations, analysis-with-followup-actions).\n" +
  "USE: when per-task context curation pays off — each task declares its files, references, and dependencies.\n" +
  "DON'T: use for linear single-action work. Use submit_plan — it's lighter and faster to approve.\n" +
  "DON'T: pad a task list with trivial items to look thorough. 3 meaningful tasks > 8 micro-tasks.\n" +
  "DON'T: submit tasks without concrete files/references per item — the user can't approve vague scope.";

export const EXECUTE_TASK_DESC =
  'Start executing one task from the approved task list. Opens a scoped sandbox on the runner.\n' +
  "USE: exactly once per approved task, in dependency order (respect depends_on).\n" +
  "USE: when you are ready to make the actual edits — execute_task opens the mutating-tool window for the task's declared files.\n" +
  "DON'T: call execute_task before the task list is approved — it will error.\n" +
  "DON'T: edit files outside the task's declared `files` list — the sandbox will refuse and waste a turn. If scope was wrong, call task_complete with errors, then submit a new task.";

export const TASK_COMPLETE_DESC =
  'Mark the current inline task as done (or failed if `errors` is set). Closes the scope.\n' +
  "USE: when you finished editing and optionally ran verification (tests, lint) for the task's files.\n" +
  "USE: with `errors` when you hit a blocker and want to surface it to the user instead of silently moving on.\n" +
  "DON'T: call this before actually finishing — the parent loop will advance to the next task expecting yours is done.\n" +
  "DON'T: list files in `files_modified` that you didn't actually touch — the sandbox audits this.";

/**
 * Optional terse-mode transform: collapses any description down to its first
 * sentence when the CODER_TERSE_TOOLS env flag is set. Called once per tool
 * at registration time (not per-turn) so the result is still cache-stable
 * within a session.
 */
export function maybeTerse(desc: string): string {
  if (process.env.CODER_TERSE_TOOLS !== '1') return desc;
  if (desc.length <= 150) return desc;
  const firstPeriod = desc.indexOf('. ');
  if (firstPeriod > 0 && firstPeriod < 200) return desc.slice(0, firstPeriod + 1);
  return desc.slice(0, 150) + '…';
}
