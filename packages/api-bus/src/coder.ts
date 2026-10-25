import type { ApiContext, AsyncStream } from './common.js';
import type {
  Brand,
  SessionId,
} from '@mcp/agent-runtime-contracts/ids.js';

export type SessionGroupId = Brand<string, 'SessionGroupId'>;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function asSessionGroupId(value: string): SessionGroupId {
  if (!UUID_PATTERN.test(value)) {
    throw new TypeError('session group id must be a canonical UUID');
  }
  return value.toLowerCase() as SessionGroupId;
}

/**
 * Coder = the single-agent runtime (CoderRunner). Sessions, providers,
 * skills, interaction, streaming.
 *
 * Routes mapped:
 *  - apps/http-api/server/routes/coder/sessions.ts (CRUD)
 *  - apps/http-api/server/routes/coder/providers.ts
 *  - apps/http-api/server/routes/coder/groups.ts
 *  - apps/http-api/server/routes/coder/skills.ts
 *  - apps/http-api/server/routes/coder/interaction.ts
 *  - apps/http-api/server/routes/coder/stream.ts (streaming run + attach)
 *  - apps/http-api/server/routes/coder/snapshot.ts
 *  - apps/http-api/server/routes/coder/active-skills.ts
 *  - apps/http-api/server/routes/coder/project-tree.routes.ts
 *  - apps/http-api/server/routes/coder/project-files.ts
 *  - apps/http-api/server/routes/coder/state.ts
 *
 * Many runtime/event types are not modelled here in detail — they come
 * from @mcp/code-agent. We surface them as `unknown` at the contract
 * layer so the handler implementation can refine. This keeps the api-bus
 * stable while the agent internals evolve.
 */

export type BuiltInAgentPreset =
  | 'explore'
  | 'research'
  | 'plan'
  | 'build'
  | 'admin'
  | 'spec'
  | 'app_db'
  | 'api'
  | 'diagram'
  | 'builder';
export type CustomAgentPreset = `custom:${string}`;
export type AgentPreset = BuiltInAgentPreset | CustomAgentPreset;
export type ToolProfile = 'bootstrap' | 'navigate' | 'full' | 'auto';
/** Provider-independent host orchestration profile. Never sent as a provider effort. */
export type ExecutionMode = 'standard' | 'ultra';
export type CoderProvider = 'anthropic' | 'openai' | 'openrouter' | 'gemini' | 'bedrock' | 'zai' | 'deepseek' | 'kimi-code' | 'claude-code' | 'cloudflare';

export interface CoderSession {
  worktree_path?: string | null;
  id: SessionId;
  project_id: number | null;
  title: string;
  provider: string;
  model: string;
  model_mode?: string;
  execution_mode_override: ExecutionMode;
  status: string;
  total_input_tokens: number;
  total_output_tokens: number;
  group_id?: SessionGroupId | null;
  is_archived: boolean;
  is_favorite: boolean;
  phase_profile_id?: number | null;
  unrestricted_tool_output?: boolean;
  tool_output_cap_level?: string | null;
  block_code_comments?: boolean;
  created_at: string;
  updated_at: string;
}

/** Core transcript fields returned as `message_rows` by the full session read. */
export interface CoderTranscriptRow {
  id: string;
  role: string;
  content_json: string;
  input_tokens: number;
  output_tokens: number;
  created_at: string;
  is_meta: 0 | 1;
}

export interface CreateSessionInput {
  worktree_path?: string | null;
  project_id: number;
  title: string;
  provider: CoderProvider;
  model?: string;
  agent?: AgentPreset;
  /** Provider-independent orchestration mode. Defaults to `standard`. */
  execution_mode?: ExecutionMode;
  /** Native provider effort. Legacy `ultra` is normalized into execution_mode. */
  reasoning_effort?: string | null;
  phase_profile_id?: number | null;
}

export interface SetSessionExecutionModeInput {
  id: SessionId;
  mode: ExecutionMode;
}

/** Compatibility surface for the legacy reasoning-effort endpoint. */
export interface SetSessionReasoningEffortInput {
  id: SessionId;
  effort: string | null;
}

export interface UpdateSessionInput {
  title?: string;
  provider?: CoderProvider;
  model?: string;
  model_mode?: string;
  group_id?: SessionGroupId | null;
  is_archived?: boolean;
  is_favorite?: boolean;
  phase_profile_id?: number | null;
  unrestricted_tool_output?: boolean;
  tool_output_cap_level?: string | null;
}

/**
 * Attachments accepted on the FIRST message of a session (mid-run
 * attachments are rejected by the runner). Shape mirrors the
 * `CoderAttachment` type in @mcp/code-agent.
 */
export interface CoderAttachment {
  name: string;
  mediaType: string;
  /** Canonical local path; the payload is not embedded in the request. */
  path?: string;
  base64?: string;
  text?: string;
}

/**
 * Structured IDE context captured at send time (active file, selections, open
 * tabs). Field names match `@mcp/code-agent`'s `IdeContext` so the handler can
 * forward it verbatim to `runCoder({ ideContext })`.
 */
export interface IdeContextInput {
  activeFile?: string;
  selections?: Array<{ path: string; startLine: number; endLine: number; text?: string }>;
  openTabs?: string[];
}

export interface SendMessageInput {
  sessionId: SessionId;
  content: string;
  attachments?: CoderAttachment[];
  max_turns?: number;
  plan_mode?: boolean;
  agent?: AgentPreset;
  profile?: ToolProfile;
  worktree?: { name?: string; branch?: string };
  thinking?: boolean;
  interject?: boolean;
  selected_skill_ids?: string[];
  /** Structured IDE context (active file / selections / open tabs) for this send. */
  ide_context?: IdeContextInput;
  /** Resume from history (last message must be a tool result). */
  resume?: boolean;
}

export interface ContinueSessionInput {
  sessionId: SessionId;
  plan_mode?: boolean;
  max_turns?: number;
  agent?: AgentPreset;
  profile?: ToolProfile;
}

/**
 * Coder bus event. Shape is intentionally loose — the runner emits many
 * subtypes (turn_start, tool_call, text_delta, tool_result, error,
 * session_snapshot_changed, run_started, run_ended, worker_log, etc.).
 * Concrete typing lives in @mcp/code-agent and is consumed by the
 * dashboard via discriminated unions.
 */
export interface CoderEvent {
  seq: number;
  event: string;
  data: unknown;
}

export interface SessionStateInfo {
  sessionId: SessionId;
  status: string;
  alive: boolean;
  updatedAt: string;
}

export interface ToolCallStats {
  sessionId: SessionId;
  totalCalls: number;
  directCalls: number;
  nestedCalls: number;
  guardOutcomes: {
    genuineErrors: number;
    rootRefusals: number;
    propagatedParentFailures: number;
    reusedCalls: number;
    shadowCandidates: number;
  };
  byName: Array<{
    name: string;
    count: number;
    errorCount: number;
    refusedCount: number;
    propagatedFailureCount: number;
    reuseCount: number;
    shadowCount: number;
    lastAt: string | null;
  }>;
  recent: Array<{
    id: string;
    seq: number;
    name: string;
    argsPreview: string;
    isError: boolean;
    durationMs: number;
    createdAt: string;
    outcome: 'success' | 'genuine_error' | 'root_refusal' | 'propagated_parent_failure' | 'reuse' | 'shadow';
    guardAction: string | null;
    guardReason: string | null;
  }>;
  savings: {
    totalRawChars: number;
    totalShapedChars: number;
    totalSavedChars: number;
    totalSavedTokensEst: number;
    byTool: Array<{ name: string; rawChars: number; shapedChars: number; savedChars: number }>;
    semanticSavedChars: number;
    jsonCrushSavedChars: number;
    hardCapSavedChars: number;
    nestedRawChars: number;
    byTechnique: Array<{
      kind: string;
      technique: string;
      calls: number;
      rawChars: number;
      shapedChars: number;
      savedChars: number;
    }>;
  };
}

// ─── Sub-namespaces ────────────────────────────────────────

export interface CoderSessionsApi {
  list(input: { projectId?: number; archived?: boolean; favorite?: boolean }, ctx: ApiContext): Promise<CoderSession[]>;
  get(input: { id: SessionId; includeMessages?: boolean }, ctx: ApiContext): Promise<{ session: CoderSession; messages?: unknown[] }>;
  create(input: CreateSessionInput, ctx: ApiContext): Promise<CoderSession>;
  update(input: { id: SessionId } & UpdateSessionInput, ctx: ApiContext): Promise<CoderSession>;
  /** Mirrors PATCH /api/coder/sessions/:id/execution-mode. */
  setExecutionMode(input: SetSessionExecutionModeInput, ctx: ApiContext): Promise<CoderSession>;
  /** Mirrors the legacy PATCH /reasoning-effort compatibility route. */
  setReasoningEffort(input: SetSessionReasoningEffortInput, ctx: ApiContext): Promise<CoderSession>;
  delete(input: { id: SessionId }, ctx: ApiContext): Promise<{ ok: true }>;

  /** Paginated messages (the dashboard chat history). */
  messages(input: { id: SessionId; cursor?: number; limit?: number }, ctx: ApiContext): Promise<{ items: unknown[]; nextCursor: number | null }>;
}

export interface CoderProvidersApi {
  list(input: void, ctx: ApiContext): Promise<unknown[]>;
  get(input: { id: string }, ctx: ApiContext): Promise<unknown>;
  setActive(input: { sessionId: SessionId; provider: CoderProvider; model: string }, ctx: ApiContext): Promise<void>;
  test(input: { provider: CoderProvider; apiKey: string }, ctx: ApiContext): Promise<{ ok: true } | { ok: false; error: string }>;
}

export interface CoderStreamApi {
  /**
   * Stream a new user message into the session and tail the response.
   * If a run is already active, the message is enqueued and the caller
   * tails from `tailFrom`. If no run is active, a fresh run is started.
   */
  sendMessage(input: SendMessageInput, ctx: ApiContext): AsyncStream<CoderEvent>;

  /** Resume a session paused on a tool-result (after /answer or /plan-response). */
  continueSession(input: ContinueSessionInput, ctx: ApiContext): AsyncStream<CoderEvent>;

  /**
   * Attach to an in-flight run. Replays buffered events from
   * `since` + 1 and forwards live events until run end or disconnect.
   */
  attach(input: { sessionId: SessionId; since?: number }, ctx: ApiContext): AsyncStream<CoderEvent>;

  state(input: { sessionId: SessionId }, ctx: ApiContext): Promise<SessionStateInfo>;
  toolStats(input: { sessionId: SessionId; recent?: number }, ctx: ApiContext): Promise<ToolCallStats>;
}

export interface CoderInteractionApi {
  /** Answer an `ask_user` tool prompt. */
  answer(input: { sessionId: SessionId; question_id: string; answer: string }, ctx: ApiContext): Promise<{ ok: true; resumed: boolean }>;

  /** Respond to a `submit_plan` (approve or revise). */
  planResponse(input: { sessionId: SessionId; plan_id: string; decision: 'approve' | 'revise'; feedback?: string }, ctx: ApiContext): Promise<{ ok: true; resumed: boolean }>;

  /** Respond to `submit_tasks`. */
  tasksResponse(input: { sessionId: SessionId; tasks_id: string; decision: 'approve' | 'revise'; feedback?: string }, ctx: ApiContext): Promise<{ ok: true; resumed: boolean }>;
}

export interface CoderGroupsApi {
  list(input: { projectId: number }, ctx: ApiContext): Promise<Array<{ id: SessionGroupId; name: string; project_id: number }>>;
  create(input: { projectId: number; name: string }, ctx: ApiContext): Promise<{ id: SessionGroupId }>;
  update(input: { projectId: number; id: SessionGroupId; name: string }, ctx: ApiContext): Promise<void>;
  delete(input: { projectId: number; id: SessionGroupId }, ctx: ApiContext): Promise<void>;
}

export interface CoderSkillsApi {
  list(input: void, ctx: ApiContext): Promise<unknown[]>;
  get(input: { id: string }, ctx: ApiContext): Promise<unknown>;
  activeForSession(input: { sessionId: SessionId }, ctx: ApiContext): Promise<string[]>;
  setActiveForSession(input: { sessionId: SessionId; skillIds: string[] }, ctx: ApiContext): Promise<void>;
}

// ─── Aggregated ────────────────────────────────────────

export interface CoderApi {
  sessions: CoderSessionsApi;
  providers: CoderProvidersApi;
  stream: CoderStreamApi;
  interaction: CoderInteractionApi;
  groups: CoderGroupsApi;
  skills: CoderSkillsApi;
}
