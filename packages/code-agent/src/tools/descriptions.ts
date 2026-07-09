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
  "DON'T: write without reading first. Always read_file / mcp__read_file / mcp__get_symbol_body BEFORE overwriting.\n" +
  "DON'T: add emojis to file content unless the user used them first or explicitly asked.";

export const CREATE_FILE_DESC =
  'Create a brand-new file (fails cleanly if the path already exists).\n' +
  "USE: adding a new source file, test, or config.\n" +
  "DON'T: use this to replace an existing file — it will error. Use write_file for replacements.\n" +
  "DON'T: create placeholder/empty files speculatively. Create only when you have the final content ready.\n" +
  "DON'T: create *.md or README/documentation files unless the user explicitly asked for docs. Don't add emojis to file content unless the user used them first.";

export const MANAGE_PATH_DESC =
  'Create directories, move/rename paths, or delete files/directories with safeguards.\n' +
  'USE: mkdir, move, rename, or safe delete operations that would otherwise need shell mkdir/mv/rm.\n' +
  "USE: delete_mode='trash' by default; recursive and permanent deletes require exact confirmation strings.\n" +
  "DON'T: use shell commands for filesystem administration when manage_path can express the operation safely.\n" +
  "DON'T: target project root, .git, .mcp-indexer, node_modules, absolute paths outside the project, or traversal paths.";

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
  'Read a file from disk directly (bypasses the indexer). Auto-returns the whole file when it has ≤800 lines.\n' +
  '\n' +
  'Decision tree (follow this BEFORE calling read_file):\n' +
  '1. Don\'t know total_lines? → call mcp__get_file_skeleton FIRST. It returns file size + outline in <100 tokens.\n' +
  '2. File ≤800 lines → read_file returns the whole file in one call (auto-full).\n' +
  '3. File >800 + you know the symbol name → pass `symbol: "<name>"` (or call mcp__get_symbol_body).\n' +
  '4. File >800 + you need everything → pass `force: true` (returns the full file in one call).\n' +
  '5. Hunting a string, not a line? → use mcp__grep_code to locate it, then read the range or symbol.\n' +
  '\n' +
  'NEVER: paginate more than twice on the same file. After 2 calls without finding what you need, switch tactics (skeleton, symbol, grep, force). The doom-loop guard aborts repetitive turns.\n' +
  '\n' +
  "USE: file you just created/modified that mcp__read_file says is unknown.\n" +
  "USE: quick sanity-check of a config/dotfile that the indexer skipped.\n" +
  "USE: in a non-indexed project, `symbol` is the cheapest way to read one function.";

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
  "Show the working tree diff (pass `staged: true` for the staged diff).\n" +
  "USE: reviewing what you (or the user) are about to commit.\n" +
  "USE: answering 'what changed?' questions about uncommitted work.\n" +
  "DON'T: diff a whole repo to understand history — use git_log for that.";

export const GIT_LOG_DESC =
  'Show recent commit history (default last 10).\n' +
  "USE: understanding recent intent/decisions, finding when a change was introduced.\n" +
  "DON'T: use as a substitute for reading the code — log messages lie, code doesn't.";

export const GIT_ADD_DESC =
  'Stage specific files for commit, passed as an array of explicit paths.\n' +
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
  "USE: for multi-line code (Python, Node, etc.), pass command='python -' (or 'node -', 'bash') with the script in the `stdin` parameter. Avoid embedding code via -c \"...\" or here-strings — quoting rules differ across cmd / bash / PowerShell / sh-in-container, and shells like cmd.exe don't understand PowerShell '@'...'@' or bash '$'...''. Example: { command: \"python -\", stdin: \"import json\\nprint(json.dumps({'ok': True}))\" }.\n" +
  "DON'T: use cat/head/tail/less to read files — use read_file or mcp__read_file.\n" +
  "DON'T: use grep/rg/ack — use mcp__grep_code (indexer-aware, cheaper, filterable by layer/language).\n" +
  "DON'T: use find/ls for exploration — use mcp__list_directory or mcp__search.\n" +
  "DON'T: use sed/awk to edit files — use edit_file.\n" +
  "DON'T: run interactive commands that expect stdin from the user (nano, vim, prompts). They'll hang and time out. The `stdin` parameter is for batch payloads (script bodies), not interactive sessions.\n" +
  "DON'T: run long-running servers in foreground (npm run dev). They'll block for 120s then abort.";

// ---------- interaction (src/core/coder/tools/interaction.ts) ----------

export const ASK_USER_DESC =
  'Pause and ask the user a single question. Strongly prefer button options (2–8) over free-form when the answer space is bounded.\n' +
  "USE: when you need a decision/preference the user alone can make (which library, scope of refactor, naming, focus area).\n" +
  "USE: when critical context is missing and guessing would waste work.\n" +
  'PREFER: 2–8 mutually-exclusive `options` so the user clicks instead of types. Buttons render in a 2-column grid. Free-form is for open answers only.\n' +
  'MULTI: set `multi_select: true` when several options can legitimately be combined ("select all that apply" — e.g. which screens, what data to store, which login methods). The answer returns the chosen values joined by ", ".\n' +
  'PREFER: if one option is your recommendation, list it FIRST and end its label with " (Recommended)" so the user sees the default at a glance.\n' +
  "DON'T: ask things you can verify yourself (file existence, type signatures, config values — READ them).\n" +
  "DON'T: ask for confirmation of obvious next steps ('should I now run the tests?'). Just do it.\n" +
  "DON'T: ask multiple small questions in sequence. Batch them into one question with options or a multi-line prompt.\n" +
  "DON'T: pass 1 option (just take that path) or 9+ (the question is too broad — split into a coarser top-level question, then drill down).\n" +
  'USE: for a SINGLE quick fork. For 2+ alternative APPROACHES at the plan-finalization gate (each with its own tradeoffs), use `decision_gate` instead.';

export const DECISION_GATE_DESC =
  'Present the user a questionnaire of genuine forks (alternative approaches) and wait for their choices. Each option carries a one-line summary + tradeoffs so the user chooses with eyes open.\n' +
  'USE: in plan mode, AFTER investigation and BEFORE submit_plan, when the task has 2+ viable approaches whose choice is a real human preference (architecture, scope, build-vs-reuse, migration strategy, UX behavior).\n' +
  'USE: batch independent forks as separate questions in ONE card (1–4 questions, 2–4 options each). Set `multi_select` on a question only when several options can legitimately be combined.\n' +
  "DON'T: use for a single quick decision — use `ask_user`.\n" +
  "DON'T: ask anything you can verify yourself (READ it), or invent a fork to look thorough — a shallow either/or you could resolve yourself is worse than no question.\n" +
  "DON'T: put more than ~4 options on a question — if you reach for more, the question is too broad; split it.";

// ---------- plan (src/core/coder/tools/plan.ts) ----------

export const SUBMIT_PLAN_DESC =
  'Submit an implementation plan and wait for user approval. Returns the verdict (approved/rejected) and optional feedback.\n' +
  "USE: in plan mode, BEFORE any mutating tool. No exceptions.\n" +
  "USE: for linear, single-action work (one refactor, one bugfix, one feature). For 2+ independent items use task_list({gate:'approve'}) instead.\n" +
  "DON'T: submit a plan that reads 'I will look at the code and decide' — do the exploration FIRST, then submit a concrete plan.\n" +
  "DON'T: try to skip the plan with a direct edit. Mutating tools are blocked until the plan is approved.\n" +
  "DON'T: re-submit a rejected plan with cosmetic tweaks — read the feedback and actually address it.";

// ---------- tasks (src/core/coder/tools/tasks.ts) ----------

export const TASK_LIST_DESC =
  'The ONE task/checklist tool. A single `gate` picks intensity — there is no separate todo tool.\n' +
  "  - gate:'track' (default) — lightweight checklist that NEVER pauses. Your live progress list during a run. " +
  'Pass the full `items` ({content, activeForm, status}) to (re)write it, or `updates` ({id, status}) to flip one item. No approval, no subagents.\n' +
  "  - gate:'approve' — gated structured list: pauses for user approval and is the ONLY thing that arms `execute_tasks` (parallel subagent waves). " +
  'Requires 2+ items, each with files + kind. For a single linear change use submit_plan instead.\n' +
  '\n' +
  'There is ONE list per session: a track checklist and an approve list cannot coexist. Picking gate:approve formalizes a checklist into a gated plan; ' +
  'do NOT keep a parallel checklist alongside an approved task list — drive the approved list with execute_tasks / update_task.\n' +
  "USE gate:'track' for multi-step work you're doing yourself (3+ steps). USE gate:'approve' when work decomposes into 2+ independent units worth approving + delegating to subagents.\n" +
  "DON'T re-write the whole list to flip a status — use `updates`. DON'T pad a list with trivial items.";

export const SUBMIT_TASKS_DESC =
  'Submit a STRUCTURED task list and wait for user approval. Returns the (possibly-edited) tasks and chosen execution mode.\n' +
  'Task IDs are generated by the backend as `tsk_...`; do not invent executable ids like task_1. Use depends_on against optional client aliases inside the same submission only.\n' +
  'REQUIRES tasks.length >= 2 — single-task submissions are rejected. Use submit_plan for linear work.\n' +
  "USE: when the work decomposes into 2+ independent items (refactors touching many files, multi-area fixes, migrations, analysis-with-followup-actions).\n" +
  "USE: when per-task context curation pays off — each task declares its files, references, and dependencies.\n" +
  "DON'T: use for linear single-action work. Use submit_plan — it's lighter and faster to approve.\n" +
  "DON'T: pad a task list with trivial items to look thorough. 3 meaningful tasks > 8 micro-tasks.\n" +
  "DON'T: submit tasks without concrete files/references per item — the user can't approve vague scope.";

export const TASK_COMPLETE_DESC =
  'Close the inline task scope opened by `execute_tasks` (inline / inline-all / smart modes). ' +
  'Marks the task as done (or failed if `errors` is set).\n' +
  "USE: when you finished editing and optionally ran verification (tests, lint) for the task's files.\n" +
  "USE: with `errors` when you hit a blocker and want to surface it to the user instead of silently moving on.\n" +
  "DON'T: call this on a subagent-mode task — the subagent owns its own lifecycle. This tool ONLY closes scopes the parent runner opened.\n" +
  "DON'T: list files in `files_modified` that you didn't actually touch — the sandbox audits this.\n" +
  "DON'T: call this from inside code_exec — it isn't exposed in the sandbox; emit it as a direct top-level tool call.\n" +
  'After this call, run `execute_tasks` again to advance to the next inline task in the run.';

/**
 * Pure terse transform: collapses a description down to its first sentence.
 * Always shortens — no env check. Use this when you want the terse form
 * unconditionally (e.g., bootstrap-tier filtering at the runner level).
 */
export function terseDescription(desc: string): string {
  if (desc.length <= 150) return desc;
  // First '.' OR newline ends the summary — same rule as the MCP bridge's
  // terse transform (mcp-bridge.ts). The house style separates the first
  // sentence from USE/DON'T blocks with '.\n' (no space), which the old
  // `indexOf('. ')` never matched, hard-cutting mid-word at 150 chars.
  const firstStop = desc.search(/[.\n]/);
  if (firstStop > 0 && firstStop <= 150) return desc.slice(0, firstStop + 1).trim();
  return desc.slice(0, 150).trim() + '…';
}

/**
 * Optional terse-mode transform: collapses any description down to its first
 * sentence when the CODER_TERSE_TOOLS env flag is set. Called once per tool
 * at registration time (not per-turn) so the result is still cache-stable
 * within a session.
 */
export function maybeTerse(desc: string): string {
  if (process.env.CODER_TERSE_TOOLS !== '1') return desc;
  return terseDescription(desc);
}
