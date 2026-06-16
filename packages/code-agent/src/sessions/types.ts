import type { AgentMessage } from '@mcp/code-agent/core/messages.js';

export interface CoderSession {
  id: number;
  project_id: number;
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

/** Top-level shape persisted in coder_tasks_state.state JSON. */
export interface TasksState {
  /** 1-2 line statement of the overall objective from the model. */
  summary: string;
  tasks: CoderTask[];
  /** Set after user approval; null while awaiting verdict. */
  execution_mode: TaskExecutionMode | null;
  /** Whether the user has approved the list. */
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
