/**
 * Tool tiers — progressive disclosure of the full tool catalog.
 *
 * On a fresh session we don't need to ship the full catalog (200+ tools across
 * native + internal MCP + company/builder) to the LLM on turn 1. The tool
 * definitions alone run ~14.7k tokens median (up to 40k) — ~3.8x the system
 * prompt — so a fat turn-1 surface is both costly and hurts tool selection.
 * Most queries ("explain X", "find Y") only need a dozen read/search tools.
 * Writing, git, and admin tools are dead weight in the prompt until the
 * conversation actually calls for them.
 *
 * This module defines the three base-profile tiers plus explicit functional
 * capability tiers. The runner builds its `tools` array each turn by
 * intersecting the registry with the currently active tier set — which starts
 * with {bootstrap}, adds runtime-owned capabilities, and grows monotonically.
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
 * Core tiers are the built-in static tiers. External MCP servers can also
 * define **custom named tiers** (e.g., "cloudflare", "github") that the agent
 * unlocks on-demand via `expand_toolset`. ToolTier is widened to `string` so
 * the runner, filter, and promotion logic work generically with any tier name.
 */
import {
  APP_STUDIO_TOOLS,
  BUILDER_TOOLS,
  COMPANY_TOOLS,
  DESIGN_SYSTEM_CONSUMER_TOOLS,
  DESIGN_SYSTEM_STUDIO_TOOLS,
  QA_TOOLS,
  SANDBOX_TOOLS,
} from '@mcp/code-agent/tools/tiers-company.js';

// Company/builder tool catalogs live in a sibling module (pure data) to keep
// this file focused on tiering logic; re-exported so tiers.ts stays the single
// public entry point for tier data.
export {
  APP_STUDIO_TOOLS,
  BUILDER_TOOLS,
  COMPANY_TOOLS,
  DESIGN_SYSTEM_CONSUMER_TOOLS,
  DESIGN_SYSTEM_STUDIO_TOOLS,
  QA_TOOLS,
  SANDBOX_TOOLS,
};

export type CoreTier =
  | 'bootstrap'
  | 'navigate'
  | 'admin'
  | 'master'
  | 'preview'
  | 'browser'
  | 'api'
  | 'diagram'
  | 'db'
  | 'company'
  | 'sandbox'
  | 'qa'
  | 'app'
  | 'design-system-studio'
  | 'design-system-consumer'
  | 'sprite-studio';
export type ToolTier = string;

/** The set of built-in core tier names. Custom tiers must not collide. */
export const CORE_TIER_NAMES: ReadonlySet<string> = new Set<CoreTier>([
  'bootstrap',
  'navigate',
  'admin',
  'master',
  'preview',
  'browser',
  'api',
  'diagram',
  'db',
  'company',
  'sandbox',
  'qa',
  'app',
  'design-system-studio',
  'design-system-consumer',
  'sprite-studio',
]);

/**
 * Preview DevTools tools — the dedicated `preview` tier. Activated only when
 * the preview backend is available (the desktop app) — see runCoder. Listed
 * explicitly so the bootstrap fallback in `getToolTier` never exposes them.
 */
export const PREVIEW_TOOLS: ReadonlySet<string> = new Set<string>([
  'preview_open',
  'preview_navigate',
  'preview_viewport',
  'preview_close',
  'preview_console',
  'preview_network',
  'preview_eval',
  'preview_screenshot',
  'preview_inspect_css',
  'preview_performance',
  'preview_memory',
  'preview_storage',
  'preview_snapshot',
  'preview_click',
  'preview_fill',
  'preview_type',
  'preview_press',
  'preview_wait_for',
  'preview_scroll',
  'preview_hover',
  'preview_double_click',
  'preview_right_click',
]);

/**
 * API client tools — the dedicated `api` tier. Activated only for the `api`
 * agent (auto-test/auto-fix of an OpenAPI surface), so these never pollute
 * other sessions' turn-1 prompt. Listed explicitly so the bootstrap fallback
 * in `getToolTier` can't expose them; other sessions unlock on demand via
 * `expand_toolset('api')`.
 */
export const API_TOOLS: ReadonlySet<string> = new Set<string>([
  'api_import_openapi',
  'api_list_requests',
  'api_get_request',
  'api_run_request',
  'api_update_request',
  'api_mark_verified',
  'api_run_collection',
]);

/**
 * Database client tools — the dedicated `db` tier (Databases-tab connections,
 * driver-backed). Registered unconditionally but listed explicitly so the
 * bootstrap fallback in `getToolTier` can't expose them on turn 1; sessions
 * unlock on demand via `expand_toolset('db')`.
 */
export const DB_TOOLS: ReadonlySet<string> = new Set<string>([
  'db_list',
  'db_schema',
  'db_query',
  'db_command',
]);

/**
 * draw.io diagram tools — the dedicated `diagram` tier. Activated only for the
 * `diagram` agent (author/edit `.drawio` files rendered in a live embedded
 * editor), so they never pollute other sessions' turn-1 prompt. Listed
 * explicitly so the bootstrap fallback in `getToolTier` can't expose them;
 * other sessions unlock on demand via `expand_toolset('diagram')`.
 */
export const DIAGRAM_TOOLS: ReadonlySet<string> = new Set<string>([
  'diagram_create',
  'diagram_update',
  'diagram_read',
  'diagram_list',
  'diagram_export',
]);

/** Public-web automation available only to the dedicated research runtime. */
export const BROWSER_TOOLS: ReadonlySet<string> = new Set<string>([
  'browser_open',
  'browser_snapshot',
  'browser_extract',
  'browser_click',
  'browser_fill',
  'browser_press',
  'browser_screenshot',
  'browser_close',
]);

/**
 * Sprite Studio tools — registered only for projects carrying the
 * `.sprite-studio/` marker. They used to ride the unknown-tool bootstrap
 * fallback, which made the administrative catalog mislabel another product
 * surface as core infrastructure.
 */
export const SPRITE_STUDIO_TOOLS: ReadonlySet<string> = new Set<string>([
  'sprite_get_project',
  'sprite_list_assets',
  'sprite_generate',
  'sprite_process',
  'sprite_export',
]);

/**
 * Profile = user-facing shorthand for "which tiers start active".
 * - bootstrap: only Tier 0 (default for new sessions)
 * - navigate:  Tier 0 + Tier 1 (default when the user asks to "implement"/"refactor")
 * - full:      all three base tiers (default for resumed sessions and --profile full)
 *
 * Note: Functional and external tiers are NEVER included in profile expansion.
 * Even 'full' only activates bootstrap+navigate+admin. runCoder derives product
 * capabilities from runtime context; external tiers remain explicit opt-ins.
 */
export type CoderProfile = 'bootstrap' | 'navigate' | 'full';

/**
 * Tier 0 — bootstrap. Always visible: the minimal read/interaction core plus
 * orchestration discovery (expand_toolset/find_tools/spawn_agent). Company,
 * App, QA, sandbox, Design System and studio tools have contextual tiers. Cold tools
 * (≤12 calls in 12k turns) were demoted to navigate — see "Phase B" markers.
 *
 * Exported for test access so regression tests can keep the global bootstrap
 * surface free of product-specific capabilities.
 */
export const BOOTSTRAP_TOOLS: ReadonlySet<string> = new Set([
  // Native — minimal read/interaction set.
  // P4 (jul/2026): native `read_file` demoted to NAVIGATE. It shipped on
  // turn 1 ALONGSIDE `mcp__read_file` (superset, indexer-aware) — two read
  // surfaces for the same job on the most expensive turn. The native one is
  // the disk fallback: pin-by-name still executes it instantly when the
  // model asks for it (bridge-down prompt names it explicitly), and
  // sessions without the MCP bridge get it seeded as an initial pin.
  'list_directory',
  'ask_user',
  'submit_plan',
  // task_list — the ONE always-on task/checklist tool (merge of todo_write +
  // submit_tasks). gate:'track' = no-pause checklist; gate:'approve' = gated +
  // arms execute_tasks. The legacy names (submit_tasks/todo_write/update_todo)
  // are demoted to NAVIGATE as back-compat aliases so only task_list is on the
  // turn-1 surface — kills the two-tool selection fork.
  'task_list',
  // list/cancel/delete/archive_tasks demoted to navigate (Phase B) — ~1 call
  // each across 12k turns. Subordinates run profile 'navigate'+ and masters
  // 'full', so they still see them; only solo bootstrap sessions defer them
  // until expand_toolset('navigate').
  // Company collaboration, App Studio, Design System, QA, sandbox and other
  // product capabilities live in dedicated contextual tiers. runCoder
  // auto-activates those tiers only when the matching runtime is present.
  'expand_toolset',
  'find_tools',
  // spawn_agent is orchestration — same tier as expand_toolset/find_tools.
  // Lives in BOOTSTRAP (not NAVIGATE) so any session can delegate without
  // needing to unlock a tier first.
  'spawn_agent',
  // collect_agents / resume_agent — the async companions of spawn_agent
  // (background job wait + failed-agent relaunch). Same tier so the model
  // can always await/retry a delegation it started.
  'collect_agents',
  'resume_agent',
  // read_agent_transcript — observability companion (audit a finished
  // agent's retained transcript). Read-only; same tier so audits never
  // require a tier unlock.
  'read_agent_transcript',
  // execute_tasks — wave-based orchestrator (PR 3). Same rationale as
  // spawn_agent: orchestration that any session must be able to call.
  'execute_tasks',
  // workflow — Ultra's declarative DAG orchestrator. Registered only under
  // the Ultra posture (index.ts); bootstrap tier so it is visible whenever
  // registered.
  'workflow',
  // update_task demoted to navigate (Phase B) — 0 calls in 12k turns.
  // self_review — pipeline-based review of the session's own snapshots; always on.
  'self_review',
  // Session Drive — single-session working notes (migrations 125/126).
  // Registered only outside company context (index.ts). save_note is the
  // write entry (kept always-on); read_plan + list_notes demoted to navigate
  // (Phase B) — 0 calls in 12k turns.
  // (Session-scoped notes — distinct from project-wide mcp__save_memory.)
  // WS12: minimal turn-1 memory surface = the durable write+read pair
  // (`remember` + `recall_memory` + `recall_conversation`) live in NEVER_TRIM
  // so the catalog cap keeps recovery available on weak models. save_note
  // (session scratchpad) + forget_memory live in
  // navigate — weak models aren't forced to disambiguate ephemeral vs durable
  // (memory also works passively via proactive injection + the run-end distiller).
  'remember',
  'recall_memory',
  'recall_conversation',
  'recall_investigations',
  'get_tool_output',
  'glob',
  // todo_write / update_todo demoted to NAVIGATE (merge): they are now
  // back-compat aliases of task_list({gate:'track', ...}); only task_list is on
  // the bootstrap surface so the model sees ONE task tool.
  // Goal tools — session objective state. create_goal + update_goal stay in
  // bootstrap: the goal-gate hides/exposes create_goal by name on status, and
  // without update_goal reachable a bootstrap-only session could never clear
  // an in-progress goal (deadlock). get_goal demoted to navigate (Phase B) —
  // only 12 calls in 12k turns.
  'create_goal',
  'update_goal',
  'invoke_skill',
  // RAG over the user-managed documentation corpus (Documentação sidebar).
  // Read-only, parallel-safe; always available so any agent mode can fall
  // back to external docs instead of guessing or hammering web_fetch.
  // rag_read_doc is the search's companion full-content read — hiding it
  // behind navigate would recreate the write_stdin-style trap documented
  // below: search prints chunk_ids on turn 1 that the agent couldn't follow.
  'rag_search_docs',
  'rag_read_doc',
  // rag_doc_outline — structural navigation companion (collection → source →
  // headings). Same bootstrap rationale as rag_read_doc: it prints chunk_ids
  // the agent must be able to follow without unlocking a tier.
  'rag_doc_outline',
  // Skill discovery — needed in lazy/compact modes so the agent can fetch
  // skill descriptions and bodies on demand without paying for them up front.
  'get_skills_list',
  'get_skill_content',
  'list_skill_namespaces',
  // MCP — token-efficient discovery / search. Hot path only. Cold read tools
  // (search_memory, get_project_overview, the code-nav family) live in navigate;
  // the cross-project + snapshot-query tools were retired from the server
  // entirely (see plan essa-fun-o-poderia-ser-cozy-scone).
  'mcp__get_project_pulse',
  'mcp__search',
  'mcp__grep_code',
  'mcp__get_file_skeleton',
  'mcp__read_file',
  'mcp__list_directory',
  // Unconditional native tools that previously rode the getToolTier bootstrap
  // fallback (untiered). Listed explicitly so the fallback is no longer load-
  // bearing — code_exec is the #1 tool (16.7% of all calls), so it MUST stay
  // always-on. view_image / submit_spec are cheap and stay on the bootstrap
  // surface they already had via the fallback.
  'code_exec',
  'view_image',
  'submit_spec',
]);

/** Tier 1 — navigate + edit. Promoted via expand_toolset('navigate'). */
export const NAVIGATE_TOOLS: ReadonlySet<string> = new Set([
  // Heavy independent reviewer remains callable/pinnable but is no longer in
  // the bootstrap catalog; self_review is the canonical always-on review.
  'request_review',
  // Native — write/edit + local exploration
  // P4: native read_file lives here (disk fallback; mcp__read_file is the
  // bootstrap read surface). Pin-by-name reaches it from bootstrap.
  'read_file',
  'write_file',
  'edit_file',
  'multi_edit',
  'create_file',
  'manage_path',
  // Codex-only freeform editor (gated to the chatgpt provider in index.ts).
  'apply_patch',
  'web_fetch',
  'web_search',
  'http_request',
  // Multi-step DocsAgent research over the indexed doc corpus (separately
  // installed via installDocsDeepResearch — not in the static registry).
  // Expensive (own agent loop, minutes + LLM cost), so it does NOT belong
  // on the turn-1 bootstrap surface it used to ride via the getToolTier
  // fallback; rag_search_docs/rag_read_doc cover the cheap path there.
  'docs_deep_research',
  'run_command',
  // Persistent-shell session trio (exec_command / write_stdin / list_sessions).
  // These are `execute`-risk and mutating — they belong alongside run_command,
  // NOT in bootstrap. They previously fell through getToolTier's `bootstrap`
  // fallback (never added to any set), which exposed `write_stdin` on turn 1 of
  // a read-only session while `write_file` stayed gated behind this tier. A
  // model that wanted to create a file then misfired write_stdin
  // (session_id="write_file", chars=<file body>), looped on "session not
  // active", and list_sessions — correctly empty — never pointed it back to
  // write_file. Co-locating them here removes that trap: bootstrap is pure
  // read/interaction again, and once navigate unlocks, the shell tools and
  // write_file arrive together.
  'exec_command',
  'write_stdin',
  'list_sessions',
  'get_diagnostics',
  'lsp_definition',
  'lsp_references',
  'lsp_hover',
  'lsp_diagnostics',
  'git_status',
  'git_diff',
  'git_log',
  // create_skill authors/updates skills in the DB (mutating). Lives in
  // navigate alongside write_file — the /skill builtin expands to this tier
  // before calling it. MUST be listed explicitly: getToolTier falls back to
  // bootstrap for unlisted tools, which would expose it on turn 1.
  'create_skill',
  // decision_gate — the plan agent's rich questionnaire of alternative
  // approaches (richer ask_user). Navigate-tier, NOT bootstrap: the plan agent
  // runs profile 'navigate' so it sees this, while solo bootstrap sessions keep
  // it off their turn-1 surface (prefix-cache head stays put).
  'decision_gate',
  // spawn_agent moved to BOOTSTRAP_TOOLS — orchestration tools live there
  // alongside expand_toolset/find_tools so any session can delegate.
  // execute_tasks (plural) is the new wave-based orchestrator (PR 3) —
  // also BOOTSTRAP so the master can dispatch the whole approved list
  // in one call. Frente D — `execute_task` (singular) is gone; only
  // `task_complete` remains to close inline scopes opened by
  // `execute_tasks` in inline / inline-all / smart modes.
  'task_complete',
  // MCP — deep navigation + edit prep
  'mcp__find_references',
  'mcp__trace_usage',
  'mcp__get_dependencies',
  'mcp__get_dependents',
  'mcp__get_symbol_body',
  'mcp__prepare_edit',
  'mcp__get_hierarchy',
  'mcp__find_implementations',
  'mcp__semantic_neighbors',
  // Retired from the MCP surface (tool audit 2026-07): mcp__get_symbol_details,
  // mcp__get_class_members, mcp__search_by_kind, mcp__search_concepts,
  // mcp__get_architecture, mcp__get_file_structure — 0-call tools covered by
  // search / skeleton / symbol_body / overview. See tier-contract retired list.
  // get_repo_map: explicitly tiered here so it stops riding the getToolTier
  // bootstrap fallback (it was untiered → always-on on turn 1). Cold overview
  // tool → navigate, reachable via expand_toolset.
  'mcp__get_repo_map',
  'mcp__get_project_overview',
  'mcp__get_recently_modified_files',
  'mcp__save_memory',
  // ─── Demoted from bootstrap (Phase B) ────────────────────────────
  // Cold always-on tools (≤12 calls across 12k turns). Subordinates run
  // profile 'navigate'+ and masters 'full', so company sessions still see
  // them; only solo bootstrap (read-only) sessions defer them to expand.
  'list_tasks',
  'cancel_tasks',
  'delete_tasks',
  'archive_task_list',
  'update_task',
  // Back-compat aliases of task_list (merge of todos+tasks). Kept reachable for
  // resumed sessions / direct callers; only task_list is bootstrap-visible.
  'submit_tasks',
  'todo_write',
  'update_todo',
  'read_plan',
  'list_notes',
  'forget_memory',
  'save_note',
  'get_goal',
  'mcp__search_memory',
  // MCP resource discovery (registered for non-master sessions). Read-only,
  // cold (≤1 call in 12k turns) — was an untiered bootstrap fallback.
  'mcp_list_resources',
  'mcp_read_resource',
]);

/**
 * Tier 3 — master / orchestration. Surfaces ONLY for company-master
 * sessions. Auto-activated by the runner when `companyContext.isMaster
 * === true`; also unlockable explicitly via `expand_toolset('master')`.
 *
 * These tools were previously visible to masters by default because they
 * fell through `getToolTier`'s `return 'bootstrap'` fallback. Moving them
 * into a dedicated tier makes the orchestration surface discoverable
 * (find_tools / expand_toolset list it explicitly) and lets the recovery
 * briefing call `expand_toolset('master')` upfront to guarantee
 * loading — closing the "Recovery blocked — required master tools
 * unavailable" failure mode observed on session 100.
 *
 * Subordinate sessions never have these tools in their registry (they
 * are only `registry.registerAll`'d in the `if (isMaster) {...}` branch
 * of runCoder), so adding the tier label is a no-op for non-masters.
 */
export const MASTER_TOOLS: ReadonlySet<string> = new Set([
  // Subordinate orchestration
  'spawn_subordinate_agent',
  'wait_for_subordinates',
  'resume_subordinate',
  'approve_subordinate_plan',
  'approve_subordinate_plans',
  'approve_subordinate_tasks',
  'answer_subordinate_question',
  'abort_subordinate_agent',
  'list_subordinates',
  'list_company_projects',
  'forward_to_agent',
  'finalize_subordinates',
  'list_containers',
  'read_container_logs',
  'recommend_role',
  'broadcast_to_roles',
  'kanban_plan_graph',
  // review_subordinate_work — master runs the review pipeline over a sub's
  // snapshots (buildMasterTools). Was an untiered bootstrap fallback.
  'review_subordinate_work',
  // Company pipeline orchestration is constructed by buildMasterTools. It is
  // not a subordinate sandbox capability and belongs to the master identity.
  'list_pipelines',
  'start_pipeline',
  'get_pipeline_status',
  'stop_pipeline',
  // Master-only kanban management. The unified `kanban_post_comment`
  // and `kanban_update_objectives` live in the shared company tier.
  'kanban_create_card',
  'kanban_move_card',
  'kanban_update_meta',
  'kanban_add_dependency',
  'kanban_remove_dependency',
  'kanban_assign_agent',
  'kanban_list_cards',
  'kanban_get_card',
]);

/** Tier 2 — admin. Never auto-promoted. */
export const ADMIN_TOOLS: ReadonlySet<string> = new Set([
  // Native — git mutations
  'git_add',
  'git_commit',
  'git_branch',
  'enter_worktree',
  'exit_worktree',
  // MCP — indexing + provider cost/model admin. delete_project and snapshot
  // CRUD tools were retired from the server (see plan
  // essa-fun-o-poderia-ser-cozy-scone): destructive project lifecycle belongs
  // to the host, and snapshot CRUD is 0-call + superseded by agent memory.
  'mcp__index_project',
  'mcp__get_costs',
  'mcp__list_models',
  'mcp__export_docs',
]);

/** Options for {@link getToolTier}. */
export interface GetToolTierOpts {
  /**
   * Strict mode: throw if `name` matches no explicit tier set instead of
   * silently returning `bootstrap`. Used by the tier-contract test to surface
   * untiered tools (the historical "silent fallback" gotcha) loudly.
   */
  strict?: boolean;
}

/**
 * Return the tier a tool belongs to.
 *
 * Runtime overrides win first (external MCP tools, tier configured per-server
 * in the DB). Then an EXPLICIT lookup across every static set. Product
 * capabilities keep their own named tiers and are auto-activated by runCoder
 * only in the matching runtime context.
 *
 * Unlisted tools default to `bootstrap` so a newly added internal tool is
 * never accidentally hidden — BUT this fallback is no longer load-bearing:
 * `tier-contract.test.ts` runs in `strict` mode and fails if any registered
 * tool reaches it, and `CODER_STRICT_TIERS=1` demotes unlisted tools to
 * `navigate` (off the turn-1 surface) in production as a belt-and-suspenders.
 */
export function getToolTier(
  name: string,
  overrides?: ReadonlyMap<string, ToolTier>,
  opts?: GetToolTierOpts,
): ToolTier {
  // Runtime overrides take precedence — external MCP tools live here.
  if (overrides?.has(name)) return overrides.get(name)!;
  if (BOOTSTRAP_TOOLS.has(name)) return 'bootstrap';
  if (NAVIGATE_TOOLS.has(name)) return 'navigate';
  if (ADMIN_TOOLS.has(name)) return 'admin';
  if (MASTER_TOOLS.has(name)) return 'master';
  if (PREVIEW_TOOLS.has(name)) return 'preview';
  if (BROWSER_TOOLS.has(name)) return 'browser';
  if (API_TOOLS.has(name)) return 'api';
  if (DIAGRAM_TOOLS.has(name)) return 'diagram';
  if (DB_TOOLS.has(name)) return 'db';
  if (COMPANY_TOOLS.has(name)) return 'company';
  if (SANDBOX_TOOLS.has(name)) return 'sandbox';
  if (QA_TOOLS.has(name)) return 'qa';
  if (APP_STUDIO_TOOLS.has(name)) return 'app';
  if (DESIGN_SYSTEM_STUDIO_TOOLS.has(name)) return 'design-system-studio';
  if (DESIGN_SYSTEM_CONSUMER_TOOLS.has(name)) return 'design-system-consumer';
  if (SPRITE_STUDIO_TOOLS.has(name)) return 'sprite-studio';
  // Unlisted — no explicit tier.
  if (opts?.strict) {
    throw new Error(
      `getToolTier: tool "${name}" is not in any tier set. Add it to a tier in ` +
        `tiers.ts (or one of the functional tier sets) so it stops riding the ` +
        `silent bootstrap fallback.`,
    );
  }
  if (process.env.CODER_STRICT_TIERS === '1') return 'navigate';
  return 'bootstrap';
}

/** Every tool name with an explicit tier placement (union of all sets). */
export function allTieredToolNames(): Set<string> {
  return new Set<string>([
    ...BOOTSTRAP_TOOLS,
    ...NAVIGATE_TOOLS,
    ...ADMIN_TOOLS,
    ...MASTER_TOOLS,
    ...PREVIEW_TOOLS,
    ...BROWSER_TOOLS,
    ...API_TOOLS,
    ...DIAGRAM_TOOLS,
    ...DB_TOOLS,
    ...COMPANY_TOOLS,
    ...SANDBOX_TOOLS,
    ...QA_TOOLS,
    ...APP_STUDIO_TOOLS,
    ...DESIGN_SYSTEM_STUDIO_TOOLS,
    ...DESIGN_SYSTEM_CONSUMER_TOOLS,
    ...SPRITE_STUDIO_TOOLS,
  ]);
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

/** Runtime facts used to derive capability tiers that must be active on turn 1. */
export interface ContextualToolTierContext {
  company?: boolean;
  sandbox?: boolean;
  qa?: boolean;
  app?: boolean;
  designSystemStudio?: boolean;
  designSystemConsumer?: boolean;
  spriteStudio?: boolean;
  isMaster?: boolean;
  previewAvailable?: boolean;
  browserAvailable?: boolean;
  agentId?: string | null;
  companyRole?: string | null;
}

/**
 * Resolve the non-profile tiers implied by the current runtime identity.
 *
 * A tier controls visibility, not authority: tools still have to be registered
 * for the runtime and pass disabled/policy filters. Keeping this derivation
 * pure gives launch paths and regression tests one contract instead of a pile
 * of role-specific pins.
 */
export function contextualTiersForRuntime(
  context: ContextualToolTierContext,
): Set<ToolTier> {
  const tiers = new Set<ToolTier>();
  const role = context.companyRole?.trim().toLowerCase() ?? '';
  if (context.company) tiers.add('company');
  if (context.sandbox) tiers.add('sandbox');
  if (context.qa) tiers.add('qa');
  if (context.app) tiers.add('app');
  if (context.designSystemStudio) tiers.add('design-system-studio');
  if (context.designSystemConsumer) tiers.add('design-system-consumer');
  if (context.spriteStudio) tiers.add('sprite-studio');
  if (context.isMaster) tiers.add('master');
  if (
    context.previewAvailable
    || ['qa', 'frontend', 'ux', 'fullstack'].includes(role)
  ) {
    tiers.add('preview');
  }
  if (context.browserAvailable && context.agentId === 'research') tiers.add('browser');
  if (context.agentId === 'api') tiers.add('api');
  if (context.agentId === 'diagram') tiers.add('diagram');
  if (context.agentId === 'app_db' || role === 'database') tiers.add('db');
  return tiers;
}

/**
 * Filter a list of tools to only those in the active tier set. Preserves
 * the input order so alphabetical sorting done upstream (mcp-bridge) is
 * retained — important for prefix-cache stability.
 *
 * `tierOverrides` is an optional runtime map for tools whose tier is resolved
 * dynamically (external MCP servers and installed plugins), rather than from
 * the static Sets above.
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
 * dynamic tools, so custom-tiered tools count toward the right ceiling.
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
  decision_gate: 'Present alternative approaches (with tradeoffs) for the user to choose before the plan',
  submit_plan: 'Submit an implementation plan for user approval',
  task_list: 'The one task tool: gate:track = no-pause checklist; gate:approve = gated list that arms execute_tasks',
  submit_tasks: 'Alias of task_list({gate:"approve"}) — submit a gated task list for approval',
  list_tasks: 'List current task ids and statuses',
  cancel_tasks: 'Cancel current tasks without deleting the audit trail',
  delete_tasks: 'Delete tasks from the current task list',
  archive_task_list: 'Clear the current task list',
  expand_toolset: 'Unlock higher-tier tools (navigate/admin)',
  find_tools: 'Search the tool catalog by name, description, and argument names',
  request_review: 'Spawn a reviewer subagent to second-opinion the diff',
  read_plan: 'Re-read your submitted plan and its approval status',
  save_note: 'Jot a scratchpad note for THIS session (ephemeral — use remember for durable memory)',
  remember: 'Save a durable fact the moment you learn it (decision/convention/gotcha/recipe)',
  forget_memory: 'Archive a durable memory by title when it becomes wrong or obsolete',
  list_notes: 'List the notes you saved with save_note this session',
  recall_memory: 'Recall durable memory by meaning before re-exploring (decisions/gotchas/recipes)',
  recall_conversation: 'Recover older chapters or original messages from this compacted conversation',
  recall_investigations: 'Find a past sub-agent exploration before re-running it',
  get_tool_output: 'Retrieve truncated output from a prior tool call',
  glob: 'Find files matching a glob pattern',
  todo_write: 'Update the lightweight todo list sidebar',
  update_todo: 'Patch a single todo by id (status/content) — companion to todo_write',
  create_goal: 'Record the session objective at the start of a task',
  get_goal: 'Read the current session goal and its status',
  update_goal: 'Update or complete the session goal',
  invoke_skill: 'Invoke a reusable skill by ID',
  rag_search_docs: 'Search the indexed documentation corpus (Documentação)',
  rag_read_doc: 'Read one doc section in full by chunk_id (+ neighbors)',
  rag_doc_outline: 'Browse a doc collection/source structurally (sources → headings)',
  docs_deep_research: 'Multi-step cited research over the doc corpus (slow, LLM cost)',
  // ─── Subordinate kanban ──────────────────────────────────────
  post_to_board: 'Post to the shared company board',
  read_board: 'Read shared company board messages',
  set_agent_status: 'Update company agent status',
  kanban_read_my_card: 'Read assigned Kanban card details',
  // Unified surface (master + subordinate). Sub omits card_id.
  kanban_post_comment: 'Add a comment to a Kanban card (omit card_id as sub)',
  kanban_update_objectives: 'Add or check off objectives (omit card_id as sub)',
  kanban_move_to_review: 'Move your card to Review (done working)',
  // ─── Bootstrap MCP ────────────────────────────────────────────
  mcp__get_project_pulse: 'Ultra-compact project overview (~100 tokens)',
  mcp__search_memory: 'Search project memory (decisions/conventions/gotchas/facts) by meaning — try before exploring code',
  mcp__search: 'Hybrid search (FTS + vector) across the project',
  mcp__grep_code: 'Text search with language/layer/glob filters',
  mcp__get_file_skeleton: 'File outline — headers + symbols (cheap)',
  mcp__read_file: 'Read file slice from the index (default 100L)',
  mcp__list_directory: 'List files by prefix (no disk access)',
  // ─── Navigate native ──────────────────────────────────────────
  write_file: 'Overwrite an existing file entirely',
  edit_file: 'Apply a targeted search-and-replace edit',
  multi_edit: 'Apply multiple edits to one file atomically',
  create_file: 'Create a new file (fails if it exists)',
  manage_path: 'Create directories, move/rename paths, or safely delete',
  web_fetch: 'Fetch a URL and extract content',
  web_search: 'Search the web for information',
  browser_open: 'Open a public page in the isolated research browser',
  browser_snapshot: 'Read visible web-page elements and refs',
  browser_extract: 'Extract rendered text from a dynamic page',
  browser_click: 'Navigate through an anonymous public page',
  browser_fill: 'Fill a public search or filter field',
  browser_press: 'Press a key in the research browser',
  browser_screenshot: 'Capture the current research page',
  browser_close: 'Close and clear the research browser context',
  run_command: 'Run a shell command (sandboxed to project)',
  // Persistent exec_command session registry. Navigate tier (with
  // exec_command / write_stdin); pairs with write_stdin's rich error to let
  // the model self-correct after a stale session_id.
  exec_command: 'Spawn a persistent shell session (REPLs, interactive CLIs) — drive it with write_stdin.',
  write_stdin: 'Write to a live exec_command session\'s stdin — does NOT create files (use write_file for that).',
  list_sessions: 'List active exec_command sessions (id, status, age) — call before write_stdin if unsure.',
  get_diagnostics: 'Get LSP diagnostics for a file',
  lsp_definition: 'Go to definition of a symbol',
  lsp_references: 'Find all references to a symbol',
  lsp_hover: 'Get hover info (types, docs) for a position',
  lsp_diagnostics: 'Get diagnostics from the language server',
  git_status: 'Show working tree status',
  git_diff: 'Show staged/unstaged changes',
  git_log: 'Show recent commit history',
  spawn_agent: 'Spawn 1 (or N parallel, up to 8) agent(s) with read/implement/full toolset',
  // Frente D — `execute_task` is gone; orchestration goes through `execute_tasks` (BOOTSTRAP).
  task_complete: 'Close the current inline task scope and mark it done (inline-mode tail of execute_tasks).',
  update_task: 'Skip / retry / rename / rescope a task without re-running submit_tasks.',
  // ─── Navigate MCP ─────────────────────────────────────────────
  mcp__find_references: 'Find all references to a symbol',
  mcp__trace_usage: 'Recursive usage tree (depth 3)',
  mcp__get_dependencies: 'What a file imports',
  mcp__get_dependents: 'Who imports/uses a file',
  mcp__get_symbol_body: 'Extract the body of a function/class',
  mcp__prepare_edit: 'One-shot bundle for editing a symbol',
  mcp__get_hierarchy: 'Extends / implements / subclasses',
  mcp__find_implementations: 'Concrete implementations of an interface',
  mcp__semantic_neighbors: 'Semantically similar symbols',
  mcp__get_repo_map: 'Structural repo map — key files by importance (~2000 tokens)',
  mcp__get_project_overview: 'Complete project overview (use compact)',
  mcp__get_recently_modified_files: 'Recently indexed files',
  mcp__save_memory: 'Save a durable fact (decision/convention/gotcha/architecture) to project memory for future sessions',
  // ─── Admin native ─────────────────────────────────────────────
  git_add: 'Stage files for commit',
  git_commit: 'Create a git commit',
  git_branch: 'Create or switch branches',
  enter_worktree: 'Create and enter an isolated git worktree',
  exit_worktree: 'Leave the current worktree',
  // ─── Admin MCP ────────────────────────────────────────────────
  mcp__index_project: 'Index or reindex a project',
  mcp__get_costs: 'View provider cost history',
  mcp__list_models: 'List available LLM models',
  mcp__export_docs: 'Export project documentation',
  // ─── DB client (Databases tab) ────────────────────────────────
  db_list: 'List registered database connections (never credentials; does not connect)',
  db_schema: 'Progressively list tables or inspect one table without loading the full schema',
  db_query: 'Run ONE SQL statement on a registered connection (read-only connections block writes)',
  db_command: 'Run a MongoDB/Redis command on a document/key-value connection',
  // ─── Diagram (draw.io) ────────────────────────────────────────
  diagram_create: 'Create a new draw.io diagram (.drawio) from mxGraph XML',
  diagram_update: 'Replace the full mxGraph XML of an existing diagram',
  diagram_read: 'Read a saved diagram\'s mxGraph XML to edit it',
  diagram_list: 'List the draw.io diagrams saved under diagrams/',
  diagram_export: 'Export a diagram to SVG/PNG via the live editor',
};

/** Searchable one-line identity for every contextual and master capability. */
const FUNCTIONAL_DESCRIPTIONS: Record<string, string> = {
  // Company collaboration
  ask_master: 'Ask the Company master for a blocking decision or clarification',
  submit_plan_to_master: 'Submit this subordinate plan to the Company master for approval',
  submit_tasks_to_master: 'Submit a gated subordinate task list to the Company master',
  submit_specification_to_master: 'Escalate a completed specification to the Company master',
  send_to_agent: 'Send a direct Company message to another agent role',
  send_to_master: 'Send a non-blocking Company message to the master',
  respond_to_inbox: 'Reply to a pending Company inbox message',
  read_my_inbox: 'Read messages addressed to this Company agent',
  check_inbox_answer: 'Check whether a prior Company inbox question was answered',
  post_to_board: 'Post a status, finding, blocker, or decision to the Company board',
  read_board: 'Read the shared Company board',
  set_agent_status: 'Publish this Company agent status',
  kanban_read_my_card: 'Read the Kanban card assigned to this subordinate',
  kanban_post_comment: 'Post a comment to a Company Kanban card',
  kanban_update_objectives: 'Add or complete objectives on a Company Kanban card',
  kanban_move_to_review: 'Move the assigned subordinate card to review',
  read_shared_file: 'Read a file from the Company shared drive',
  write_shared_file: 'Write a file to the Company shared drive',
  append_shared_file: 'Append content to a Company shared-drive file',
  delete_shared_file: 'Delete a file from the Company shared drive',
  list_shared_files: 'List files in the Company shared drive',
  send_message: 'Send a message to a live agent in the current Company tree',
  send_input: 'Interrupt a live Company agent with additional input',
  list_agents: 'List agents and statuses in the current Company tree',
  wait_agents: 'Wait for one or more Company agents to progress or finish',
  followup_task: 'Send follow-up work to an existing Company agent',
  env_list: 'List shared environment variables for this Company session',
  env_read: 'Read one shared Company environment variable',
  env_set: 'Create or update a shared Company environment variable',
  env_delete: 'Delete a shared Company environment variable',
  env_validate: 'Validate required shared Company environment variables',

  // Sandbox / builder
  docs_delete: 'Delete a document from the sandbox workspace docs directory',
  docs_index_update: 'Refresh the sandbox documentation index',
  docs_list: 'List documents stored inside the sandbox workspace',
  docs_read: 'Read a document from the sandbox workspace',
  docs_write: 'Write a document inside the sandbox workspace',
  read_sandbox_logs: 'Read recent logs from the bound sandbox',
  list_services: 'List services and health in the bound sandbox',
  service_logs: 'Read structured logs for one sandbox service',
  service_restart: 'Restart an authorized sandbox service',
  service_start: 'Start an authorized sandbox service',
  service_stop: 'Stop an authorized sandbox service',

  // Generic QA
  qa_get_browser_endpoint: 'Resolve and validate the browser endpoint for a QA run',
  qa_publish_result: 'Publish a structured QA result to the Company work graph',
  qa_start_run: 'Start a tracked Company QA test run',

  // App Studio v6
  app_get_state: 'Read the current App Studio v6 workflow state',
  app_get_plan: 'Read the active App Studio v6 plan revision',
  app_update_plan: 'Validate and save a new App Studio v6 plan revision',
  app_upsert_work_items: 'Create or update App Studio v6 work items',
  app_request_decision: 'Request a durable product decision for the App workflow',
  app_request_plan_approval: 'Request user approval of the active App plan',
  app_dispatch_ready_work: 'Dispatch ready App work to its persistent specialist roles',
  app_record_work_evidence: 'Record implementation or verification evidence for App work',
  app_get_db_state: 'Read the database state linked to this App',
  app_update_database: 'Apply an App database state update or migration',
  app_run_checks: 'Run the checks owned by an App specialist role',

  // Design System Studio / consumer
  ds_get_session_info: 'Read the current Design System Studio package and version context',
  ds_record_component: 'Record an approved component in the Design System draft',
  ds_list_components: 'List draft and published Design System components',
  ds_audit_package: 'Audit the Design System package before publication',
  ds_set_version_status: 'Update the current Design System version status',
  ds_publish_version: 'Publish the approved Design System version',
  ds_get_pipeline: 'Read the Design System Studio pipeline state',
  ds_submit_stage: 'Submit an artifact to a Design System pipeline stage',
  ds_analyze_import: 'Analyze an imported package for Design System adoption',
  ds_components: 'List components from the Design System linked to this project',
  ds_component: 'Read one linked Design System component and its props',
  ds_docs: 'Read documentation from the linked Design System version',

  // Sprite Studio
  sprite_get_project: 'Read the Sprite Studio project style contract and asset summary',
  sprite_list_assets: 'List assets and versions in the Sprite Studio project',
  sprite_generate: 'Generate and save a sprite from a visual intent',
  sprite_process: 'Apply deterministic processing to create a sprite version',
  sprite_export: 'Export Sprite Studio assets into the project output directory',

  // Company master
  spawn_subordinate_agent: 'Spawn a persistent Company subordinate for a role and task',
  wait_for_subordinates: 'Wait for persistent Company subordinates to progress or finish',
  resume_subordinate: 'Resume a stopped or failed Company subordinate',
  approve_subordinate_plan: 'Approve or reject one subordinate plan',
  approve_subordinate_plans: 'Resolve multiple pending subordinate plans in one operation',
  approve_subordinate_tasks: 'Approve or reject a subordinate task list',
  answer_subordinate_question: 'Answer a blocking question from a subordinate',
  abort_subordinate_agent: 'Abort a running Company subordinate',
  list_subordinates: 'List persistent subordinates and their current states',
  list_company_projects: 'List projects available to the Company team',
  forward_to_agent: 'Forward context or instructions to a Company agent',
  finalize_subordinates: 'Finalize completed subordinate runs and collect their results',
  list_containers: 'List containers owned by the Company session',
  read_container_logs: 'Read logs from a Company-managed container',
  recommend_role: 'Recommend the best Company role for a task',
  broadcast_to_roles: 'Broadcast one message to multiple Company roles',
  kanban_plan_graph: 'Create a dependency-aware Company Kanban work graph',
  review_subordinate_work: 'Run the master review pipeline over subordinate changes',
  list_pipelines: 'List Company execution pipelines',
  start_pipeline: 'Start a Company execution pipeline',
  get_pipeline_status: 'Read the current Company pipeline status',
  stop_pipeline: 'Stop a Company execution pipeline',
  kanban_create_card: 'Create one or more Company Kanban cards',
  kanban_move_card: 'Move one or more Company Kanban cards between columns',
  kanban_update_meta: 'Update Company Kanban card metadata',
  kanban_add_dependency: 'Add a dependency between Company Kanban cards',
  kanban_remove_dependency: 'Remove a dependency between Company Kanban cards',
  kanban_assign_agent: 'Assign a Company agent to a Kanban card',
  kanban_list_cards: 'List Company Kanban cards',
  kanban_get_card: 'Read one Company Kanban card in detail',
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
        description: SHORT_DESCRIPTIONS[name] ?? FUNCTIONAL_DESCRIPTIONS[name] ?? '',
      });
    }
  };
  push('bootstrap', BOOTSTRAP_TOOLS);
  push('navigate', NAVIGATE_TOOLS);
  push('admin', ADMIN_TOOLS);
  push('master', MASTER_TOOLS);
  push('preview', PREVIEW_TOOLS);
  push('browser', BROWSER_TOOLS);
  push('api', API_TOOLS);
  push('diagram', DIAGRAM_TOOLS);
  push('db', DB_TOOLS);
  push('company', COMPANY_TOOLS);
  push('sandbox', SANDBOX_TOOLS);
  push('qa', QA_TOOLS);
  push('app', APP_STUDIO_TOOLS);
  push('design-system-studio', DESIGN_SYSTEM_STUDIO_TOOLS);
  push('design-system-consumer', DESIGN_SYSTEM_CONSUMER_TOOLS);
  push('sprite-studio', SPRITE_STUDIO_TOOLS);
  return result;
}

/** Exposed for telemetry / tests. */
export const TIER_COUNTS = {
  bootstrap: BOOTSTRAP_TOOLS.size,
  navigate: NAVIGATE_TOOLS.size,
  admin: ADMIN_TOOLS.size,
  master: MASTER_TOOLS.size,
  preview: PREVIEW_TOOLS.size,
  browser: BROWSER_TOOLS.size,
  api: API_TOOLS.size,
  diagram: DIAGRAM_TOOLS.size,
  db: DB_TOOLS.size,
  company: COMPANY_TOOLS.size,
  sandbox: SANDBOX_TOOLS.size,
  qa: QA_TOOLS.size,
  app: APP_STUDIO_TOOLS.size,
  'design-system-studio': DESIGN_SYSTEM_STUDIO_TOOLS.size,
  'design-system-consumer': DESIGN_SYSTEM_CONSUMER_TOOLS.size,
  'sprite-studio': SPRITE_STUDIO_TOOLS.size,
} as const;
