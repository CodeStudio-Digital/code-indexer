import type {
  AgentAttachment,
  DecisionAnswers,
  StreamTask,
  StreamTaskExecutionMode,
} from '../../hooks/useAgentStream.js';

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
  initialSessionId?: number;
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
}

export interface CoderSession {
  id: number;
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
  provider: string;
  model: string;
  /** Added by migration 006. '' when provider doesn't distinguish modes. */
  model_mode?: string;
  status: string;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cache_read_tokens: number;
  total_cache_creation_tokens: number;
  /** Most recent turn's input tokens — actual context window usage. */
  last_turn_input_tokens: number;
  /** Optional group (folder) this session belongs to (migration 009). */
  group_id: number | null;
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
  agent?: 'explore' | 'plan' | 'build' | 'admin' | 'spec' | 'app_spec' | 'app_db' | 'app_architect' | 'builder' | 'api' | 'diagram' | null;
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
  id: number;
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
  type: 'text' | 'tool_use' | 'tool_result' | 'image' | 'document';
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string;
  is_error?: boolean;
  mediaType?: string;
  base64?: string;
  _truncated?: boolean;
  _originalLength?: number;
  _hasBase64?: boolean;
}

export interface PersistedMessage {
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
  id: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens?: number;
  cache_creation_tokens?: number;
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
  /** Status fallback for tool calls whose tool_result block is missing. Absent/empty for healthy sessions. */
  tool_results?: ToolResultFallback[];
  /** Linked projects for a global session (migration 152). Empty for normal sessions. */
  linked_projects?: LinkedProject[];
}

/** Response shape from GET /api/coder/sessions/:id/messages?before_id=N */
export interface MessagePage {
  messages: PersistedMessage[];
  message_rows: MessageRow[];
  tool_results?: ToolResultFallback[];
}

export interface EnrichedProviderModel {
  id: string;
  name: string;
  mode: string | null;
  context_window?: number | null;
  default_max_tokens?: number | null;
  /** Discrete reasoning-effort levels this model accepts (e.g.
   *  `['minimal','low','medium','high','xhigh']`). Non-empty → the composer
   *  shows the effort selector. Null/empty → hidden. */
  supported_reasoning_levels?: string[] | null;
  /** Model's default effort when no override is set. Shown as the "auto" hint. */
  default_reasoning_level?: string | null;
}

export interface ProviderCapabilities {
  supportsThinking?: boolean;
  supportsVision?: boolean;
}

export interface EnrichedProvider {
  id: string;
  name: string;
  kind: string;
  is_default?: boolean;
  has_key?: boolean;
  models: EnrichedProviderModel[];
  capabilities?: ProviderCapabilities;
}

export interface ProviderOption {
  id: string;
  label: string;
  /** The provider's `kind` (e.g. `'chatgpt'`, `'openai'`, `'gemini'`).
   *  Distinct from `id` for providers whose DB id doesn't match the kind
   *  (e.g. ChatGPT Codex has id `openai-chatgpt` but kind `chatgpt`). */
  kind?: string;
  models: EnrichedProviderModel[];
  capabilities?: ProviderCapabilities;
}

export interface PersistedTasksState {
  summary: string;
  tasks: StreamTask[];
  execution_mode: StreamTaskExecutionMode | null;
  approved: boolean;
  current_task_id: string | null;
}

export interface PromptHandlers {
  onAnswer: (answer: string) => Promise<void>;
  onPlanResponse: (verdict: { approved: boolean; aborted?: boolean; feedback?: string }) => Promise<void>;
  onTasksResponse: (verdict: {
    approved: boolean;
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
  ) => Promise<void>;
  /** Fork the session at the given persisted user-message id: create a new
   *  session containing history up to (exclusive) the message, pre-fill the
   *  composer with the message text for editing. */
  onFork?: (messageId: number) => Promise<void> | void;
  /** Roll the session back to the given persisted user-message id: DELETE that
   *  message and everything after it (in place, destructive), then re-seed the
   *  composer with its text + attachments for editing and re-sending. */
  onRollback?: (messageId: number) => Promise<void> | void;
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
  onDecide?: (answers: DecisionAnswers) => Promise<void>;
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

export type { AgentAttachment };
