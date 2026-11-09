import type { DecisionAnswers, SessionId, StreamTask, StreamTaskExecutionMode } from '../../hooks/useAgentStream.js';
import type { AgentPreset } from '@mcp/api-bus';

export interface AgentChatWorkbenchSlots {
  toolbarHost?: HTMLElement | null;
  sessionsHost: HTMLElement | null;
  rightPanelHost: HTMLElement | null;
  rightRailHost: HTMLElement | null;
  onSessionStateChange?: (state: { hasSession: boolean; rightPanelOpen: boolean }) => void;
  onSessionSelected?: (sessionId: SessionId) => void;
}

/** Optional project preview contributed to the session's right activity rail. */
export interface AgentChatPreviewConfig {
  /** Builder projects pin the dev port in their generated Vite config. */
  pinnedPort?: number;
  /** Enables source-aware element and region selection for stamped builders. */
  selectionEnabled?: boolean;
  /** Inferred project framework, used to choose the best selector strategy. */
  framework?: 'next' | 'react' | 'vue' | 'angular' | null;
}

/** A project linked to a global (multi-project) session. */
export interface LinkedProject {
  project_id: number;
  name: string;
  root_path: string;
  is_primary: boolean;
  label: string | null;
}

export interface AgentChatProps {
  /** Primary project. Optional in `mode="global"` (the session list is
   *  cross-project and a session's primary comes from its own row). */
  projectId?: number;
  projectName?: string;
  /**
   * `'project'` (default) — the per-project Sessões view. `'global'` — the
   * "Sessões Globais" surface: cross-project session list + multi-project
   * sessions. Defaults to `'project'` so every existing call site is unchanged.
   */
  mode?: 'project' | 'global';
  /** Optional session to pre-select on mount, set when the user clicks a
   *  recent-session entry in the global sidebar. */
  initialSessionId?: SessionId;
  /**
   * Builder studio: when set, each outgoing message is prefixed with the
   * element the user selected in the preview (consumed + cleared from the
   * studio-context-store, keyed by this session id). Absent for normal
   * workspace chat.
   */
  selectionPrefixSessionId?: number;
  /**
   * Hide the agent picker in the composer. Used by guided surfaces (App
   * Studio) where the session is locked to a single agent and exposing the
   * generic explore/plan/build switcher only confuses a layperson (and
   * switching away would break the guided flow).
   */
  hideAgentPicker?: boolean;
  /** Project workbench integration: moves the session list and contextual
   * tools into the IDE's existing docks instead of nesting a second shell. */
  workbenchSlots?: AgentChatWorkbenchSlots;
  /** Live project preview exposed as one mutually-exclusive right-rail panel. */
  preview?: AgentChatPreviewConfig;
}

export interface CoderSession {
  worktree_path?: string | null;
  id: SessionId;
  project_id: number;
  /** Global (multi-project) session flag (migration 152). */
  is_global?: boolean;
  /** Primary project name — only enriched on the global-sessions list payload. */
  project_name?: string;
  /** Joined names of every linked project ("ProjA + ProjB") — only on the
   *  global-sessions list payload; the sidebar groups by virtual workspace and
   *  shows this as the group header. */
  workspace_label?: string;
  /** Count of linked projects — only on the global-sessions list payload. */
  linked_count?: number;
  title: string;
  /** Present only on a one-way snapshot imported from another coding agent. */
  import_source?: 'claude-code' | 'codex' | null;
  import_external_id?: string | null;
  import_fingerprint?: string | null;
  import_source_updated_at?: string | null;
  imported_at?: string | null;
  provider: string;
  model: string;
  /** Added by migration 006. '' when provider doesn't distinguish modes. */
  model_mode?: string;
  status: string;
  runtime_active?: boolean;
  runtime_bus_id?: string | null;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cache_read_tokens: number;
  total_cache_creation_tokens: number;
  /** Most recent turn's input tokens — actual context window usage. */
  last_turn_input_tokens: number;
  /** Optional filesystem-backed group (folder) this session belongs to. */
  group_id: string | null;
  is_archived: boolean;
  archived_at: string | null;
  /** Pin-to-top flag (migration 010). */
  is_favorite: boolean;
  favorited_at: string | null;
  /** Phase profile bound to this session (Camada 2). Null = single-model. */
  phase_profile_id?: number | null;
  /**
   * Per-session "unrestricted tool output" toggle (migration 078). When true,
   * the runner / mcp-bridge / code_exec lift their per-tool-call truncation
   * caps to a high safety ceiling (≈1 MB). Auto-compaction still runs.
   * Surfaced as a switch in the Composer.
   */
  unrestricted_tool_output?: boolean | null;
  /** Per-session tool-output cap level (migration 153): economic|medium|high|extra|max|ultra. */
  tool_output_cap_level?: string | null;
  /**
   * Per-session tool permission mode (migration 131) driving the
   * PermissionGate: 'ask' pauses every write/execute/admin tool, 'auto'
   * pauses execute/admin only, 'unrestricted' never pauses. NULL → 'auto'.
   * Surfaced as the shield toggle in the Composer.
   */
  tool_permission_mode?: 'ask' | 'auto' | 'unrestricted' | null;
  /**
   * Per-session agent/mode (explore/plan/build/admin/spec/builder/api).
   * Drives the composer's agent select. Persisted on the session row so the
   * select reflects the actual session state on reload (hydrated on session
   * load) and live transitions (plan→build) via `coder:session_agent_changed`.
   */
  agent?: AgentPreset | null;
  /** Durable compaction summary (mig 128). Rendered as a card above the chat
   *  when set; the older messages it covers are hidden behind the boundary. */
  compaction_summary?: string | null;
  /**
   * Per-session sticky reasoning-effort override (migration 150), e.g.
   * `minimal`/`low`/`medium`/`high`/`xhigh`. Orthogonal to the thinking toggle.
   * NULL → provider/model default. Surfaced as the effort selector in the
   * Composer (only for models exposing supported_reasoning_levels).
   */
  reasoning_effort_override?: string | null;
  /** Product execution profile. Ultra is orchestration + max native effort, not an API effort. */
  execution_mode_override?: ExecutionMode;
  /** Sticky extended-thinking toggle for this conversation (migration 226). */
  thinking_enabled?: boolean;
  /** Defaults true. Prevents the agent from adding comments inside generated code. */
  block_code_comments?: boolean;
  /** Null means the session runs until natural completion. */
  max_turns?: number | null;
  /** Extra batches after an enabled turn limit. */
  max_auto_continues?: number;
  /**
   * Per-session sticky plan-depth (migration 151): 'simple' | 'normal' |
   * 'complex'. NULL → 'normal'. Surfaced as the depth selector in the Composer
   * only while the `plan` agent is active.
   */
  plan_depth_override?: string | null;
  /** Per-session response language (migration 177). NULL → auto (user's language). */
  response_language_override?: string | null;
  /** Per-session output style (migration 178): proactive | explanatory | learning. NULL → proactive. */
  output_style_override?: string | null;
  created_at: string;
  updated_at: string;
}

export interface CoderSessionGroup {
  id: string;
  seq: number;
  project_id: number;
  name: string;
  color: string | null;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface CoderSessionStats {
  total_input_tokens: number;
  total_output_tokens: number;
  total_cache_read_tokens: number;
  total_cache_creation_tokens: number;
  last_turn_input_tokens: number;
  /** Cache-inclusive prompt size of the last assistant turn (input + cache
   *  read + cache creation) — the at-rest counterpart of the live
   *  `context_status.prompt_tokens`. Null for sessions with no turns. */
  last_turn_prompt_tokens?: number | null;
  /** Model context window size — returned by the stats API. */
  context_window?: number | null;
  message_count: number;
  assistant_turns: number;
  tool_call_count: number;
  tool_error_count: number;
  distinct_tools: number;
  subagent_call_count: number;
  total_tool_duration_ms: number;
  duration_ms: number;
}

export interface ContentBlock {
  type: 'text' | 'thinking' | 'tool_use' | 'tool_result' | 'image' | 'document';
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string;
  is_error?: boolean;
  mediaType?: string;
  path?: string;
  base64?: string;
  _truncated?: boolean;
  _originalLength?: number;
  _hasBase64?: boolean;
}

export interface PersistedMessage {
  /** Internal system input retained for replay but hidden from the transcript. */
  isMeta?: boolean;
  role: 'user' | 'assistant' | 'tool';
  content: ContentBlock[];
  /**
   * Skill IDs the user pre-selected in the sidebar when sending this user
   * message (migration 095). Rendered as audit pills above the user bubble
   * so the chat shows WHICH skills were applied to a turn without dumping
   * the (potentially huge) skill bodies into the bubble itself. Absent for
   * assistant/tool messages and for pre-migration user rows.
   */
  selectedSkillIds?: string[];
}

export interface MessageRow {
  /** Stable UUID record identity. Never use it for ordering or pagination. */
  id: string;
  /** Monotonic conversation order within this session. */
  seq: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens?: number;
  cache_creation_tokens?: number;
  /** Client-only placeholder rendered while the authoritative row is being persisted. */
  optimistic?: boolean;
}

/**
 * Audit-table fallback entry for a tool call whose `tool_result` block is
 * missing from `messages` (pre-fix sessions where a mid-run compaction dropped
 * the tool message). The message list seeds its tool-result map from these so
 * the call shows its real terminal status instead of a perpetual spinner.
 */
export interface ToolResultFallback {
  tool_use_id: string;
  content: string;
  is_error: boolean;
  _truncated?: boolean;
  _originalLength?: number;
}

export interface ToolResultView {
  content: string;
  isError: boolean;
  image?: { mediaType: string; base64: string };
  truncated?: boolean;
  originalLength?: number;
}

export interface SessionData {
  session: CoderSession;
  messages: PersistedMessage[];
  message_rows: MessageRow[];
  /** Total number of *visible* messages (excludes rows hidden behind a summary boundary). */
  total_messages?: number;
  /** Count of messages hidden behind a manual "summarize & clear" boundary. 0 = none. */
  archived_count?: number;
  /** User message immediately before the loaded window. It owns an assistant
   *  tail that starts mid-turn after compaction or pagination. */
  preceding_user_seq?: number | null;
  /** Status fallback for tool calls whose tool_result block is missing. Absent/empty for healthy sessions. */
  tool_results?: ToolResultFallback[];
  /** Linked projects for a global session (migration 152). Empty for normal sessions. */
  linked_projects?: LinkedProject[];
}

/** Response shape from GET /api/coder/sessions/:id/messages?before_seq=N */
export interface MessagePage {
  messages: PersistedMessage[];
  message_rows: MessageRow[];
  /** Authoritative exclusive cursor for the next older page. */
  next_before_seq: number | null;
  /** Authoritative backend answer; never infer exhaustion from an empty merge. */
  has_more: boolean;
  preceding_user_seq?: number | null;
  tool_results?: ToolResultFallback[];
}

export type EarlierMessagePageResult =
  | {
      ok: true;
      addedRows: number;
      nextBeforeSeq: number | null;
      hasMore: boolean;
    }
  | {
      ok: false;
      reason: 'aborted' | 'error' | 'stale';
      error?: string;
    };

export type ExecutionMode = 'standard' | 'ultra';

export interface PersistedTasksState {
  summary: string;
  tasks: StreamTask[];
  execution_mode: StreamTaskExecutionMode | null;
  approved: boolean;
  current_task_id: string | null;
}

export interface PromptHandlers {
  onAnswer: (answer: string, interactionId?: string) => Promise<void>;
  onPlanResponse: (verdict: { approved: boolean; aborted?: boolean; feedback?: string; interactionId?: string }) => Promise<void>;
  onTasksResponse: (verdict: {
    approved: boolean;
    interaction_id?: string;
    feedback?: string;
    tasks?: StreamTask[];
    execution_mode?: StreamTaskExecutionMode;
  }) => Promise<void>;
  /**
   * Verdict on a submit_spec submission (SDD mode). `spec_path` lets the
   * server log the resolved path even when the runner has been recycled.
   */
  onSpecResponse?: (
    approved: boolean,
    spec_path: string,
    requested_changes?: string,
    interactionId?: string,
  ) => Promise<void>;
  /** Fork the session at the given persisted user-message sequence: create a new
   *  session containing history up to (exclusive) the message, pre-fill the
   *  composer with the message text for editing. */
  onFork?: (messageSeq: number) => Promise<void> | void;
  /** Roll the session back to the given persisted user-message sequence: hide that
   *  message and everything after it (in place, destructive), then re-seed the
   *  composer with its text + attachments for editing and re-sending. */
  onRollback?: (messageSeq: number) => Promise<void> | void;
  /** Persisted message currently being rolled back. While set, all rollback
   *  actions are disabled and the matching message shows progress. */
  rollbackPendingSeq?: number | null;
  /**
   * PermissionGate verdict — resolves a tool call paused awaiting approval
   * (POST /tool-approval). Wired by AgentChat; the ToolCallBlock renders the
   * approval card only when this handler exists.
   */
  onToolApproval?: (
    toolUseId: string,
    verdict: { approved: boolean; note?: string; alwaysAllow?: boolean },
  ) => Promise<void>;
  /** Resolve a `decision_gate` questionnaire — the user's chosen approaches.
   *  Optional so hosts that don't render plan-mode forks can omit it. */
  onDecide?: (answers: DecisionAnswers, interactionId?: string) => Promise<void>;
  /**
   * Session the stream belongs to. Live agent rows use it for per-agent
   * abort (POST /agents/abort) and retained-transcript fetches; persisted
   * paths already carry it via resultSource.
   */
  sessionId?: SessionId;
}

// ─── Visual grouping for chat display ───────────────────────────
export type VisualGroup =
  | { kind: 'user'; message: PersistedMessage; messageId?: number; usage?: MessageRow }
  | {
      kind: 'assistant';
      messages: PersistedMessage[];
      messageIds: (number | undefined)[];
      usages: (MessageRow | undefined)[];
      hasText: boolean;
    };
