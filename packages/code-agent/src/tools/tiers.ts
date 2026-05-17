/**
 * Tool tiers — progressive disclosure of the full tool catalog.
 *
 * On a fresh session we don't need to ship all 57 tools to the LLM on turn 1.
 * Most queries ("explain X", "find Y") only need a dozen read/search tools.
 * Writing, git, and admin tools are dead weight in the prompt until the
 * conversation actually calls for them.
 *
 * This module defines 3 tiers and a filter helper. The runner builds its
 * `tools` array each turn by intersecting the registry with the currently
 * active tier set — which starts as {bootstrap} and grows monotonically.
 * Tiers never shrink, so once navigate is promoted, the tool list only
 * grows; this matters for server-side prefix caching (Anthropic ephemeral
 * / ZAI auto-cache) because the prefix becomes stable again from the turn
 * AFTER promotion.
 *
 * Tier 2 (admin) is NEVER auto-promoted. It requires an explicit
 * `expand_toolset('admin')` call from the agent (via the hint in the
 * system prompt) or a `--profile full` CLI flag.
 */

/**
 * Core tiers are the 3 built-in static tiers. External MCP servers can also
 * define **custom named tiers** (e.g., "cloudflare", "github") that the agent
 * unlocks on-demand via `expand_toolset`. ToolTier is widened to `string` so
 * the runner, filter, and promotion logic work generically with any tier name.
 */
export type CoreTier = 'bootstrap' | 'navigate' | 'admin';
export type ToolTier = string;

/** The set of built-in core tier names. Custom tiers must not collide. */
export const CORE_TIER_NAMES: ReadonlySet<string> = new Set<CoreTier>([
  'bootstrap',
  'navigate',
  'admin',
]);

/**
 * Profile = user-facing shorthand for "which tiers start active".
 * - bootstrap: only Tier 0 (default for new sessions)
 * - navigate:  Tier 0 + Tier 1 (default when the user asks to "implement"/"refactor")
 * - full:      all tiers (default for resumed sessions and --profile full)
 *
 * Note: Custom tiers are NEVER included in profile expansion. Even 'full'
 * only activates the 3 core tiers. The agent explicitly opts in to custom
 * tiers via `expand_toolset`, keeping the prompt lean.
 */
export type CoderProfile = 'bootstrap' | 'navigate' | 'full';

/**
 * Tier 0 — bootstrap. Always visible. ~13 tools.
 *
 * Exported for test access — the membership of company-specific tools
 * (kanban subordinate, design-system) is treated as a contract that
 * regression tests should be able to inspect directly.
 */
export const BOOTSTRAP_TOOLS: ReadonlySet<string> = new Set([
  // Native — minimal read/interaction set
  'read_file',
  'list_directory',
  'ask_user',
  'submit_plan',
  'submit_tasks',
  // Subordinate variants (company mode — same events, master-directed names)
  'ask_master',
  'submit_plan_to_master',
  'submit_tasks_to_master',
  // Company board tools — mandatory communication channel for master +
  // subordinates. Keep explicit so they cannot disappear from tool config.
  'post_to_board',
  'read_board',
  'set_agent_status',
  'kanban_read_my_card',
  // Subordinate kanban tools (company mode — self-service card updates)
  'kanban_my_comment',
  'kanban_my_checklist',
  'kanban_move_to_review',
  // Design System Creator tools (company mode — DS sessions). All four
  // were previously visible only via the `'bootstrap'` fallback in
  // `getToolTier`; registering them here makes the contract grep-able
  // and matches the pattern used for the kanban subordinate tools.
  'ds_get_session_info',
  'ds_record_component',
  'ds_validate_manifest',
  'ds_validate_stories',
  'ds_audit_package',
  'ds_set_version_status',
  'ds_publish_version',
  'expand_toolset',
  'find_tools',
  'request_review',
  'get_tool_output',
  'glob',
  'todo_write',
  'invoke_skill',
  // Skill discovery — needed in lazy/compact modes so the agent can fetch
  // skill descriptions and bodies on demand without paying for them up front.
  'get_skills_list',
  'get_skill_content',
  // MCP — token-efficient discovery / search
  'mcp__get_project_pulse',
  'mcp__query_snapshots',
  'mcp__get_context_for',
  'mcp__search',
  'mcp__grep_code',
  'mcp__get_file_skeleton',
  'mcp__read_file',
  'mcp__list_directory',
  'mcp__list_projects',
  'mcp__get_project_stats',
]);

/** Tier 1 — navigate + edit. Promoted via expand_toolset('navigate'). */
const NAVIGATE_TOOLS: ReadonlySet<string> = new Set([
  // Native — write/edit + local exploration
  'write_file',
  'edit_file',
  'multi_edit',
  'create_file',
  // Codex-only freeform editor (gated to the chatgpt provider in index.ts).
  'apply_patch',
  'web_fetch',
  'web_search',
  'run_command',
  'run_command_pty',
  'get_diagnostics',
  'lsp_definition',
  'lsp_references',
  'lsp_hover',
  'lsp_diagnostics',
  'git_status',
  'git_diff',
  'git_log',
  'spawn_subagent',
  'spawn_agents',
  'execute_task',
  'task_complete',
  // MCP — deep navigation + edit prep
  'mcp__find_references',
  'mcp__trace_usage',
  'mcp__get_dependencies',
  'mcp__get_dependents',
  'mcp__get_symbol_body',
  'mcp__get_symbol_details',
  'mcp__prepare_edit',
  'mcp__get_class_members',
  'mcp__get_hierarchy',
  'mcp__find_implementations',
  'mcp__semantic_neighbors',
  'mcp__search_by_kind',
  'mcp__search_concepts',
  'mcp__get_architecture',
  'mcp__get_file_structure',
  'mcp__get_project_overview',
  'mcp__get_project_context',
  'mcp__get_recently_modified_files',
  'mcp__search_global',
  'mcp__list_snapshots',
]);

/** Tier 2 — admin. Never auto-promoted. */
const ADMIN_TOOLS: ReadonlySet<string> = new Set([
  // Native — git mutations
  'git_add',
  'git_commit',
  'git_branch',
  'enter_worktree',
  'exit_worktree',
  // MCP — project + snapshot mutations, cost/model admin
  'mcp__index_project',
  'mcp__delete_project',
  'mcp__get_costs',
  'mcp__estimate_cost',
  'mcp__list_models',
  'mcp__export_docs',
  'mcp__get_diff',
  'mcp__add_snapshot',
  'mcp__update_snapshot',
  'mcp__delete_snapshot',
  'mcp__get_snapshot_history',
]);

/**
 * Return the tier a tool belongs to.
 *
 * Static lookup first (internal tools in BOOTSTRAP / NAVIGATE / ADMIN sets),
 * then optional runtime overrides (for external MCP server tools whose tier
 * is configured per-server in the DB). Unknown tools default to `bootstrap`
 * so newly added internal tools are never hidden.
 */
export function getToolTier(
  name: string,
  overrides?: ReadonlyMap<string, ToolTier>,
): ToolTier {
  // Runtime overrides take precedence — external MCP tools live here.
  if (overrides?.has(name)) return overrides.get(name)!;
  if (NAVIGATE_TOOLS.has(name)) return 'navigate';
  if (ADMIN_TOOLS.has(name)) return 'admin';
  return 'bootstrap';
}

/** Expand a profile name into the set of active tiers. */
export function profileToTiers(profile: CoderProfile): Set<ToolTier> {
  switch (profile) {
    case 'bootstrap':
      return new Set<ToolTier>(['bootstrap']);
    case 'navigate':
      return new Set<ToolTier>(['bootstrap', 'navigate']);
    case 'full':
      return new Set<ToolTier>(['bootstrap', 'navigate', 'admin']);
  }
}

/**
 * Filter a list of tools to only those in the active tier set. Preserves
 * the input order so alphabetical sorting done upstream (mcp-bridge) is
 * retained — important for prefix-cache stability.
 *
 * `tierOverrides` is an optional runtime map for external MCP tools whose
 * tier is configured per-server in the DB (not in the static Sets above).
 */
export function filterByTiers<T extends { name: string }>(
  tools: readonly T[],
  activeTiers: ReadonlySet<ToolTier>,
  tierOverrides?: ReadonlyMap<string, ToolTier>,
): T[] {
  return tools.filter((t) => activeTiers.has(getToolTier(t.name, tierOverrides)));
}

/**
 * Inspect the tool calls actually made in a resumed session's history and
 * pick the smallest profile that covers them. Used to avoid promoting every
 * resumed session to 'full' when the conversation only used bootstrap tools.
 *
 *  - any 'admin' tool used → 'full'
 *  - any 'navigate' tool used → 'navigate'
 *  - else → 'bootstrap'
 *
 * `tierOverrides` is the same runtime map the runner already passes down for
 * external MCP tools, so custom-tiered tools count toward the right ceiling.
 */
export function inferProfileFromHistory(
  toolNames: Iterable<string>,
  tierOverrides?: ReadonlyMap<string, ToolTier>,
): CoderProfile {
  let sawNavigate = false;
  for (const name of toolNames) {
    const tier = getToolTier(name, tierOverrides);
    if (tier === 'admin') return 'full';
    if (tier === 'navigate') sawNavigate = true;
  }
  return sawNavigate ? 'navigate' : 'bootstrap';
}

/**
 * Detect an initial profile from the user's first message. Pure heuristic,
 * zero LLM cost. Runs only when `CODER_PROFILE_AUTO=1` OR when the caller
 * passes `profile: 'auto'`.
 *
 * - "commit"/"push"/"branch" → full (git mutations needed)
 * - "refatore"/"implemente"/"corrija"/"adicione"/"crie" → navigate
 * - anything else → bootstrap
 */
export function inferProfileFromMessage(msg: string): CoderProfile {
  const lower = msg.toLowerCase();
  if (/\b(commit|push|branch|tag|stash|rebase|merge|release)\b/.test(lower)) {
    return 'full';
  }
  if (
    /\b(refatore|refactor|implemente|implement|corrija|fix|adicione|add|crie|create|escreva|write|edite|edit|build|deploy|rename|move|delete|remove)\b/.test(
      lower,
    )
  ) {
    return 'navigate';
  }
  return 'bootstrap';
}

/**
 * Short one-line descriptions for the UI. Kept separate from the full LLM
 * descriptions in descriptions.ts — those are multi-paragraph; these are
 * ~60-char summaries for toggle lists and tooltips.
 */
const SHORT_DESCRIPTIONS: Record<string, string> = {
  // ─── Bootstrap native ─────────────────────────────────────────
  read_file: 'Read file contents (with line range support)',
  list_directory: 'List files and directories',
  ask_user: 'Ask the user a question and wait for a reply',
  submit_plan: 'Submit an implementation plan for user approval',
  submit_tasks: 'Submit a task list for user approval',
  expand_toolset: 'Unlock higher-tier tools (navigate/admin)',
  find_tools: 'Search the full tool catalog by description',
  request_review: 'Spawn a reviewer subagent to second-opinion the diff',
  get_tool_output: 'Retrieve truncated output from a prior tool call',
  glob: 'Find files matching a glob pattern',
  todo_write: 'Update the lightweight todo list sidebar',
  invoke_skill: 'Invoke a reusable skill by ID',
  // ─── Subordinate kanban ──────────────────────────────────────
  post_to_board: 'Post to the shared company board',
  read_board: 'Read shared company board messages',
  set_agent_status: 'Update company agent status',
  kanban_read_my_card: 'Read assigned Kanban card details',
  kanban_my_comment: 'Add a comment to your assigned Kanban card',
  kanban_my_checklist: 'Check off or add objectives on your card',
  kanban_move_to_review: 'Move your card to Review (done working)',
  // ─── Bootstrap MCP ────────────────────────────────────────────
  mcp__get_project_pulse: 'Ultra-compact project overview (~100 tokens)',
  mcp__query_snapshots: 'Full-text search over project snapshots',
  mcp__get_context_for: 'Curated context bundle for an NL question',
  mcp__search: 'Hybrid search (FTS + vector) across the project',
  mcp__grep_code: 'Text search with language/layer/glob filters',
  mcp__get_file_skeleton: 'File outline — headers + symbols (cheap)',
  mcp__read_file: 'Read file slice from the index (default 100L)',
  mcp__list_directory: 'List files by prefix (no disk access)',
  mcp__list_projects: 'List all indexed projects',
  mcp__get_project_stats: 'Project metrics (files, symbols, concepts)',
  // ─── Navigate native ──────────────────────────────────────────
  write_file: 'Overwrite an existing file entirely',
  edit_file: 'Apply a targeted search-and-replace edit',
  multi_edit: 'Apply multiple edits to one file atomically',
  create_file: 'Create a new file (fails if it exists)',
  web_fetch: 'Fetch a URL and extract content',
  web_search: 'Search the web for information',
  run_command: 'Run a shell command (sandboxed to project)',
  run_command_pty: 'Run a shell command in a PTY (interactive)',
  get_diagnostics: 'Get LSP diagnostics for a file',
  lsp_definition: 'Go to definition of a symbol',
  lsp_references: 'Find all references to a symbol',
  lsp_hover: 'Get hover info (types, docs) for a position',
  lsp_diagnostics: 'Get diagnostics from the language server',
  git_status: 'Show working tree status',
  git_diff: 'Show staged/unstaged changes',
  git_log: 'Show recent commit history',
  spawn_subagent: 'Launch a scoped sub-agent for a subtask',
  execute_task: 'Execute a task from the approved task list',
  task_complete: 'Mark the current task as completed',
  // ─── Navigate MCP ─────────────────────────────────────────────
  mcp__find_references: 'Find all references to a symbol',
  mcp__trace_usage: 'Recursive usage tree (depth 3)',
  mcp__get_dependencies: 'What a file imports',
  mcp__get_dependents: 'Who imports/uses a file',
  mcp__get_symbol_body: 'Extract the body of a function/class',
  mcp__get_symbol_details: 'Full details of a symbol by ID',
  mcp__prepare_edit: 'One-shot bundle for editing a symbol',
  mcp__get_class_members: 'List members of a class',
  mcp__get_hierarchy: 'Extends / implements / subclasses',
  mcp__find_implementations: 'Concrete implementations of an interface',
  mcp__semantic_neighbors: 'Semantically similar symbols',
  mcp__search_by_kind: 'Filter symbols by type (function, class, ...)',
  mcp__search_concepts: 'Find files by semantic concept',
  mcp__get_architecture: 'Architecture by layer',
  mcp__get_file_structure: 'Full file details (verbose)',
  mcp__get_project_overview: 'Complete project overview (use compact)',
  mcp__get_project_context: 'All project snapshots (use max_tokens)',
  mcp__get_recently_modified_files: 'Recently indexed files',
  mcp__search_global: 'Search across all projects',
  mcp__list_snapshots: 'List project snapshots',
  // ─── Admin native ─────────────────────────────────────────────
  git_add: 'Stage files for commit',
  git_commit: 'Create a git commit',
  git_branch: 'Create or switch branches',
  enter_worktree: 'Create and enter an isolated git worktree',
  exit_worktree: 'Leave the current worktree',
  // ─── Admin MCP ────────────────────────────────────────────────
  mcp__index_project: 'Index or reindex a project',
  mcp__delete_project: 'Remove a project from the index',
  mcp__get_costs: 'View indexing costs',
  mcp__estimate_cost: 'Estimate cost of indexing',
  mcp__list_models: 'List available LLM models',
  mcp__export_docs: 'Export project documentation',
  mcp__get_diff: 'Diff between indexing runs',
  mcp__add_snapshot: 'Create a project snapshot',
  mcp__update_snapshot: 'Update an existing snapshot',
  mcp__delete_snapshot: 'Delete a snapshot',
  mcp__get_snapshot_history: 'Snapshot version history',
};

/** Metadata for a single known tool. */
export interface ToolMeta {
  name: string;
  tier: ToolTier;
  source: 'native' | 'mcp' | 'mcp_external';
  description: string;
}

/**
 * Return metadata for every tool registered in the tier maps. Used by
 * the admin tools API and the session tool config dialog to enumerate
 * the full catalog without spinning up an MCP bridge.
 */
export function getAllKnownToolsMeta(): ToolMeta[] {
  const result: ToolMeta[] = [];
  const push = (tier: ToolTier, set: ReadonlySet<string>) => {
    for (const name of set) {
      result.push({
        name,
        tier,
        source: name.startsWith('mcp__') ? 'mcp' : 'native',
        description: SHORT_DESCRIPTIONS[name] ?? '',
      });
    }
  };
  push('bootstrap', BOOTSTRAP_TOOLS);
  push('navigate', NAVIGATE_TOOLS);
  push('admin', ADMIN_TOOLS);
  return result;
}

/** Exposed for telemetry / tests. */
export const TIER_COUNTS = {
  bootstrap: BOOTSTRAP_TOOLS.size,
  navigate: NAVIGATE_TOOLS.size,
  admin: ADMIN_TOOLS.size,
} as const;
