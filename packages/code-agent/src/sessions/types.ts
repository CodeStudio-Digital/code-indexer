import type { AgentMessage } from '@mcp/code-agent/core/messages.js';

export interface CoderSession {
  id: number;
  /**
   * The PRIMARY project (the native cwd). Always NOT NULL. For a global session
   * (`is_global`), additional linked projects live in `coder_session_projects`
   * and are exposed to the agent as `mcp__<slug>__*` read tools + writable roots;
   * the primary stays the default root. For a normal session this is the only
   * project.
   */
  project_id: number;
  /**
   * Global (multi-project) session flag (migration 152). When true the session
   * is NOT tied to a single project: it lists under the "Sessões Globais" menu
   * (not under any project) and the runner exposes every linked project's tools.
   * Defaults to false — every pre-existing session is non-global, so the
   * per-project list and the single-root tool layer behave exactly as before.
   */
  is_global: boolean;
  title: string;
  provider: string;
  model: string;
  status: 'idle' | 'running' | 'error';
  total_input_tokens: number;
  total_output_tokens: number;
  /** Cache-read tokens (cheaper, ~50% bill) accumulated across all turns. */
  total_cache_read_tokens: number;
  /** Cache-write tokens (Anthropic ephemeral) accumulated across all turns. */
  total_cache_creation_tokens: number;
  /** Optional group (folder) this session belongs to. */
  group_id: number | null;
  /** Archive flag — archived sessions are hidden from the default list. */
  is_archived: boolean;
  archived_at: string | null;
  /** Pin-to-top flag — favorited sessions sort above non-favorited. */
  is_favorite: boolean;
  favorited_at: string | null;
  /** Serialized lightweight todo list maintained by the `todo_write` tool. JSON string or null. */
  todos_json: string | null;
  /** Absolute path of the git worktree this session is scoped to (set by `enter_worktree`). */
  worktree_path: string | null;
  /** Fallback provider to use when the primary provider fails persistently. */
  fallback_provider: string | null;
  /** Fallback model to use with the fallback provider. */
  fallback_model: string | null;
  /** CloudCode session UUID — persisted so the same ID is reused across reconnects. */
  cloudcode_session_id: string | null;
  /** Most recent turn's input_tokens — represents actual context window usage. */
  last_turn_input_tokens: number;
  /** Selected agent preset (explore | plan | build | admin). Sticky across turns so resume paths honour the user's choice. */
  agent: string | null;
  /**
   * Last `response.id` returned by the Responses API for this session, used as
   * `previous_response_id` on the next turn. Only populated for ChatGPT/Codex
   * sessions running with `store: true`. Null for other providers.
   */
  last_response_id: string | null;
  /**
   * Count of messages that were on the server side when `last_response_id` was
   * returned. The provider sends only `messages.slice(last_response_message_count)`
   * on the next turn — the backend reconstructs the prefix from the stored
   * response. Null for non-Codex sessions.
   */
  last_response_message_count: number | null;
  /**
   * Per-session sampling temperature override. When non-null, takes precedence
   * over the role-level and agent-level defaults in `resolveTemperature`. Range
   * [0, 1] enforced by the resolver — out-of-range values are clamped, not
   * rejected at write-time, so the UI can be permissive.
   */
  temperature_override: number | null;
  /**
   * Per-session sticky reasoning-effort override (migration 150), e.g.
   * `minimal`/`low`/`medium`/`high`/`xhigh`. Orthogonal to `thinking`. When
   * non-null, forwarded to the provider via `ChatRequest.reasoningEffort`,
   * taking precedence over the `thinking`-derived effort and the model's
   * `default_reasoning_level`. NULL → provider default. Only meaningful for
   * models exposing `supported_reasoning_levels`.
   */
  reasoning_effort_override: string | null;
  /**
   * Per-session sticky plan-depth override (migration 151) for the `plan`
   * agent: `simple` | `normal` | `complex`. Drives how deeply the planning
   * agent investigates and the target size of the produced plan (a ceiling,
   * not a quota — a trivial task gets a small plan even in `complex`). NULL →
   * `normal`. Unlike `reasoning_effort_override`, this feeds the SYSTEM PROMPT
   * (cache-stable axis), not a provider sampling param. Only meaningful while
   * the active agent is `plan`.
   */
  plan_depth_override: string | null;
  /**
   * Per-session sticky response-language override (migration 177). A concrete
   * language name (e.g. "Português (Brasil)", "English") feeds the `# Language`
   * block of the SYSTEM PROMPT (cache-stable axis). NULL/"auto" → falls back to
   * the project default then the neutral "respond in the user's language" form.
   */
  response_language_override: string | null;
  /**
   * Per-session sticky output style (migration 178): `proactive` (default) |
   * `explanatory` | `learning`. Feeds the SYSTEM PROMPT (cache-stable axis).
   * NULL/`proactive` → no extra block.
   */
  output_style_override: string | null;
  /**
   * Cached task-preflight seed (migration 180), JSON of `PreflightSeed`. Set by
   * the http-api on a FRESH session's first POST and reused on subsequent fresh
   * POSTs so the pre-analysis runs at most once while the agent still receives
   * the `<preflight>` hint. NULL when no preflight ran. Obsolete once the
   * session has its first persisted message.
   */
  preflight_seed_json: string | null;
  /**
   * Per-session toggle that lifts the per-tool-call truncation caps when true.
   * When null/false, the runner uses the production defaults
   * (PUSH_TIME_CAP=24k, MCP_OUTPUT_HARD_CAP=16k, code_exec MAX_OUTPUT_BYTES=50k).
   * When true, those caps are raised to a high safety ceiling (≈1 MB main /
   * 500 KB subagent / 5 000 lines for read_file). Auto-compaction still runs.
   *
   * Surfaced in the Composer next to the temperature control. Useful when
   * working with verbose MCP servers (Unity scene-analyzer, large file reads,
   * batched code_exec scripts) where truncation hurts the agent's quality.
   */
  unrestricted_tool_output: boolean | null;
  /**
   * Per-session sticky tool-output cap LEVEL (migration 153): economic | medium
   * | high | extra | max | ultra. Supersedes the legacy binary
   * `unrestricted_tool_output` — scales the per-tool-call truncation caps
   * proportionally (economic = 24k base on the main runner → ultra ≈ 4 MB).
   * When NULL, the runner derives the level from `unrestricted_tool_output`
   * (1 → 'max', else 'economic'). Stored as TEXT; validated at the write path
   * (PATCH `/api/coder/sessions/:id/tool-output-cap-level`). Surfaced as the
   * cap selector in the Composer.
   */
  tool_output_cap_level: import('../core/runner/output-caps.js').ToolOutputCapLevel | null;
  /**
   * Per-session tool permission mode (migration 131). Drives the
   * PermissionGate: 'ask' pauses every write/execute/admin tool for user
   * approval, 'auto' pauses only execute/admin, 'unrestricted' never pauses.
   * NULL → 'auto' for single coder sessions (company runs override to
   * 'unrestricted' at the call site in V1).
   */
  tool_permission_mode: 'ask' | 'auto' | 'unrestricted' | null;
  /**
   * JSON string[] of tool names the user marked "always allow" for this
   * session (migration 131). Seeds the PermissionGate grant set so repeat
   * approvals are skipped. NULL → no grants.
   */
  tool_permission_grants: string | null;
  /**
   * Sticky tier profile (migration 142). Resolved once (explicit > preflight >
   * heuristic), then reused on every resume so the visible tool array stays
   * byte-stable across runs (prompt-cache prefix). Widen-only — see
   * `setToolProfile`. NULL → legacy session: adopt once from
   * `inferProfileFromHistory` on the next run and persist.
   */
  tool_profile: 'bootstrap' | 'navigate' | 'full' | null;
  /**
   * Widen-only toolset companion state (migration 142):
   * `{v:1, extraTiers:[], pins:[], visibleCap:null}` JSON. NULL → empty.
   */
  tool_state_json: string | null;
  /**
   * Durable compaction boundary (migration 128). When non-null, every message
   * loader (runner seed + dashboard GET) only returns rows with
   * `id > summary_boundary_id`; older rows stay in the table but drop out of
   * the default view. NULL = no boundary (show the full transcript).
   */
  summary_boundary_id: number | null;
  /**
   * Rendered summary text covering everything ≤ `summary_boundary_id`. The
   * runner prepends it to its loaded history; the dashboard renders it as a
   * "conversation summary" card. NULL when there is no boundary.
   */
  compaction_summary: string | null;
  created_at: string;
  updated_at: string;
}

/** Recent session enriched with project name for the global sidebar list. */
export interface RecentCoderSession extends CoderSession {
  project_name: string;
}

/**
 * One `coder_session_projects` junction row (migration 152). Links a global
 * session to a project. The primary project is stored here too with
 * `is_primary = 1`, so the runner reads a single table to discover every root.
 */
export interface CoderSessionProject {
  coder_session_id: number;
  project_id: number;
  label: string | null;
  is_primary: number;
}

/**
 * A linked project enriched with its name + root, for the API payload, the
 * "linked projects" chip, and the runner's multi-root assembly. Resolved by
 * joining `coder_session_projects` against `projects`.
 */
export interface LinkedProject {
  project_id: number;
  name: string;
  root_path: string;
  is_primary: boolean;
  label: string | null;
}

/**
 * A global session for the "Sessões Globais" sidebar: the primary project name
 * plus how many projects are linked, so the list renders "N projetos" without
 * an N+1.
 */
export interface GlobalCoderSession extends RecentCoderSession {
  linked_count: number;
  /** Joined names of every linked project (e.g. "ProjA + ProjB") — the sidebar
   *  groups global sessions by their virtual workspace and uses this as the
   *  group header. Empty when no project is resolvable. */
  workspace_label: string;
}

/** Per-project folder used to organize chat sessions in the sidebar. */
export interface CoderSessionGroup {
  id: number;
  project_id: number;
  name: string;
  color: string | null;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface CoderMessageRow {
  id: number;
  session_id: number;
  role: 'user' | 'assistant' | 'tool';
  content_json: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  created_at: string;
  /**
   * PR-4 (Row 8): 1 when the row is a runtime-injected synthetic message
   * (stop-guard nudge, auto-continue recap, subordinate reminder, etc.)
   * that the dashboard should hide from the user-visible transcript.
   * Migration 075 adds the column; pre-PR-4 rows are 0/null.
   */
  is_meta?: 0 | 1 | null;
  /**
   * JSON array of skill IDs the user picked in the sidebar when sending
   * this message (migration 095). NULL when no picks were made or for
   * pre-migration rows. The runner re-resolves each ID against the skill
   * store on every turn so updates to a skill's prompt body take effect
   * immediately — we never persist the skill body itself here.
   */
  selected_skill_ids_json?: string | null;
}

/** Provenance of an append-only conversation chapter (migration 208). */
export type ConversationChapterSource = 'auto' | 'manual' | 'legacy' | 'rebuild';

/**
 * Persisted chapter payload. JSON columns intentionally stay opaque strings:
 * the store must preserve V3 (and future) schemas byte-for-byte without
 * depending on the summarizer implementation.
 */
export interface ConversationChapterRow {
  id: number;
  session_id: number;
  ordinal: number;
  start_message_id: number;
  end_message_id: number;
  source: ConversationChapterSource;
  trigger: string;
  title: string;
  chapter_json: string;
  chapter_text: string;
  resume_json: string;
  resume_text: string;
  version: number;
  metrics_json: string | null;
  created_at: string;
  superseded_at: string | null;
}

export interface ConversationChapterSearchResult extends ConversationChapterRow {
  /** FTS5 BM25 score; lower values are more relevant. */
  rank: number;
}

export interface ConversationChapterPage<T> {
  items: T[];
  /** Opaque store cursor. Null means the page is complete. */
  next_cursor: string | null;
}

export interface CommitConversationChapterInput {
  sessionId: number;
  /** Boundary read before summarization; compare-and-set concurrency guard. */
  expectedBoundaryId: number;
  startMessageId: number;
  endMessageId: number;
  source: Extract<ConversationChapterSource, 'auto' | 'manual'>;
  trigger: string;
  title: string;
  chapterJson: string;
  chapterText: string;
  resumeJson: string;
  resumeText: string;
  version: number;
  metricsJson?: string | null;
}

export type CommitConversationChapterResult =
  | {
      status: 'committed';
      chapter: ConversationChapterRow;
      boundary_id: number;
      pruned_count: number;
    }
  | {
      status: 'noop';
      reason: 'boundary_changed' | 'already_committed' | 'no_messages';
      chapter?: ConversationChapterRow;
      boundary_id: number;
      pruned_count: 0;
    };

export interface RebuiltConversationChapterInput {
  startMessageId: number;
  endMessageId: number;
  trigger: string;
  title: string;
  chapterJson: string;
  chapterText: string;
  resumeJson: string;
  resumeText: string;
  version: number;
  metricsJson?: string | null;
}

export interface InsertRebuiltConversationChaptersResult {
  items: ConversationChapterRow[];
  superseded_count: number;
}

/**
 * Aggregate metrics for a single session, computed in SQLite via a single
 * query (cheaper than recalculating in the front-end on every render).
 */
export interface CoderSessionStats {
  total_input_tokens: number;
  total_output_tokens: number;
  total_cache_read_tokens: number;
  total_cache_creation_tokens: number;
  /** Most recent turn's input_tokens — cache-blind (raw input only). */
  last_turn_input_tokens: number;
  /** Cache-inclusive prompt of the last assistant turn (input + cache read +
   *  cache creation) — the at-rest counterpart of the live
   *  `context_status.prompt_tokens`. Null for sessions with no turns. */
  last_turn_prompt_tokens?: number | null;
  message_count: number;
  assistant_turns: number;
  tool_call_count: number;
  tool_error_count: number;
  distinct_tools: number;
  subagent_call_count: number;
  total_tool_duration_ms: number;
  /** Wall-clock duration of the session, in ms (updated_at - created_at). */
  duration_ms: number;
  /**
   * Resolved context window for this session's model. Sourced from
   * provider_models.context_window when present, else from the static
   * registry's prefix fallback (capabilities.getRegistryContextWindow).
   * Null when the model is unknown — the dashboard hides the context bar
   * in that case rather than fabricate a percentage.
   */
  context_window?: number | null;
}

export interface CoderToolCallRow {
  id: number;
  message_id: number;
  tool_use_id: string;
  tool_name: string;
  args_json: string;
  result_text: string | null;
  is_error: number;
  duration_ms: number;
  guard_action: 'allow' | 'reuse' | 'warn' | 'block' | 'shadow' | null;
  guard_reason: string | null;
  would_block: number | null;
  state_epoch: number | null;
  result_novel: number | null;
  coverage_novel: number | null;
  delivered: number | null;
  repeat_policy: 'stable' | 'volatile' | 'pollable' | 'mutating' | null;
  execution_class: 'read' | 'write' | 'execute' | 'control' | null;
  guard_origin_tool_use_id: string | null;
  created_at: string;
}

export interface SessionWithMessages {
  session: CoderSession;
  messages: AgentMessage[];
  message_rows: CoderMessageRow[];
}

export type CoderPlanStatus = 'pending' | 'approved' | 'rejected' | 'aborted';

/**
 * One row per submit_plan call. Status starts as 'pending' and is updated
 * when the user responds (live or via the resume path after restart).
 */
export interface CoderPlanRow {
  id: number;
  session_id: number;
  tool_use_id: string;
  message_id: number | null;
  plan_text: string;
  status: CoderPlanStatus;
  feedback: string | null;
  created_at: string;
  resolved_at: string | null;
}

// ─── Session inputs / hidden-prompt log (migration 061) ───────

export type SessionInputKind =
  | 'system_prompt'
  | 'skill_content'
  | 'system_reminder'
  | 'subagent_prompt'
  | 'tools_snapshot'
  /**
   * Phase router noticed a profile asked for a different provider family
   * than the session is on, and silently skipped the swap. Recorded once
   * per session run (dedup'd by content_hash) so the dashboard can flag
   * "your profile was partially ignored". Body is JSON of skipped samples.
   */
  | 'phase_route_skip_summary'
  /**
   * Task-preflight outcome for the session's FIRST prompt. Body is the
   * rendered `<preflight>` hint on success, or a short diagnostic on
   * failure; meta carries status/latency/model/picks for the funnel.
   */
  | 'preflight';

/**
 * One row per hidden prompt the agent sees: the run-start system prompt,
 * skill bodies fetched mid-conversation, runtime system-reminders, and
 * system prompts handed to spawned sub-agents. Surfaced in the "Input" tab
 * of the session details modal as a debugging trail.
 */
export interface SessionInputRow {
  id: number;
  session_id: number;
  kind: SessionInputKind;
  source_label: string;
  content: string;
  content_hash: string;
  meta_json: string | null;
  created_at: string;
}

// ─── Tasks (migration 008) ─────────────────────────────────────

export type TaskStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped' | 'interrupted';

/** Curated context the orchestrator pre-extracts and ships to a subagent. */
export type TaskReference =
  | { type: 'symbol'; value: string; file?: string; lines?: string; note?: string }
  | { type: 'snippet'; value: string; file?: string; lines?: string; note?: string }
  | { type: 'file'; value: string; file?: string; lines?: string; note?: string }
  | { type: 'doc'; value: string; file?: string; lines?: string; note?: string };

/**
 * Kind of work the task represents. Drives toolset selection in the new
 * `execute_tasks` orchestrator (PR 3):
 *   - 'investigate' → READ_ONLY_FILTER subagent (cheap exploration).
 *   - 'implement'   → READ_WRITE_FILTER subagent + path scope on `files`.
 *   - 'verify'      → subagent with run_command + read + lsp_diagnostics
 *                     only (tests, linters, type-checkers).
 * Optional in JSON for backward compat — defaults to 'implement' on parse
 * (most conservative: gives write access if the model forgot to declare).
 */
export type TaskKind = 'investigate' | 'implement' | 'verify';

/** A single executable unit produced by submit_tasks and consumed by execute_task. */
export interface CoderTask {
  id: string;
  title: string;
  description: string;
  /**
   * Track-gate (lightweight checklist) fields — set only when the owning
   * `TasksState.gate === 'track'`. `content` is the imperative label and
   * `activeForm` the present-continuous shown while the item runs. They mirror
   * the old `TodoItem` shape so a track list renders as a no-pause checklist.
   * Undefined for `gate === 'approve'` tasks (which use `title`/`description`).
   */
  content?: string;
  activeForm?: string;
  files: string[];
  references: TaskReference[];
  depends_on: string[];
  suggested_mode: 'inline' | 'subagent';
  estimated_complexity: 'small' | 'medium' | 'large';
  /**
   * Optional grouping label. Tasks that share a `parallel_group` AND have
   * no unfinished dependency on each other run CONCURRENTLY in the same
   * wave (via `runParallelAgents`). Null/undefined → strictly sequential.
   */
  parallel_group?: string;
  /**
   * Defaults to 'implement' when omitted. Drives `execute_tasks` dispatch.
   */
  kind?: TaskKind;
  // runtime state
  status: TaskStatus;
  mode_used?: 'inline' | 'subagent';
  result?: TaskResult;
  started_at?: string;
  finished_at?: string;
  /**
   * Optional human-readable reason set when the orchestrator declined to
   * run this task (e.g. `execute_tasks` was called while the approved
   * execution_mode is 'inline' and the user requires explicit subagent
   * dispatch). Does NOT change `status` — the task remains `pending` and
   * can still be retried — but the dashboard surfaces a "skipped" badge
   * so the user understands the run intentionally bypassed this task.
   */
  reject_reason?: string;
  /**
   * When true (PR-D), the skip-stale fingerprint check is bypassed and
   * the task always runs even if its inputs haven't changed since the
   * last successful execution. Useful when the user knows side-effects
   * outside the file scope changed (env vars, DB seeds, external API).
   */
  force_run?: boolean;
}

export interface TaskResult {
  summary: string;
  files_modified: string[];
  // ChatUsage from src/coder/core/messages.ts; left as Record to avoid circular import here.
  subagent_usage?: Record<string, number | undefined>;
  errors?: string;
  sandbox_violations?: string[];
}

export type TaskExecutionMode = 'inline' | 'all-subagent' | 'smart' | 'per-task';

/**
 * Intensity axis of the unified task list (merge of the old `todos` and
 * `submit_tasks` systems).
 *   - 'track'   = lightweight self-tracking checklist; NEVER pauses, no
 *                 approval, does NOT arm `execute_tasks`. Items use
 *                 `content`/`activeForm`. (Replaces the old todo_write list.)
 *   - 'approve' = gated structured task list; pauses for user approval and is
 *                 the ONLY thing that arms `execute_tasks` subagent waves.
 * Omitted on legacy rows → treated as 'approve' (their only prior meaning).
 */
export type TaskGate = 'track' | 'approve';

/** Top-level shape persisted in coder_tasks_state.state JSON. */
export interface TasksState {
  /** Intensity gate. Undefined on legacy rows ⇒ read as 'approve'. */
  gate?: TaskGate;
  /** 1-2 line statement of the overall objective from the model. */
  summary: string;
  tasks: CoderTask[];
  /** Set after user approval; null while awaiting verdict. */
  execution_mode: TaskExecutionMode | null;
  /** Whether the user has approved the list. Always true for `gate==='track'`. */
  approved: boolean;
  /** Currently-running task id (for resume detection). */
  current_task_id: string | null;
}

export interface CoderTasksRow {
  session_id: number;
  tool_use_id: string;
  state: string; // JSON of TasksState
  version: number;
  created_at: string;
  updated_at: string;
}
