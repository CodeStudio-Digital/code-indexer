import type { ApiContext, AsyncStream } from './common.js';

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
 *  - apps/http-api/server/routes/coder/pipelines.ts
 *  - apps/http-api/server/routes/coder/pipelines-state.ts
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

export type AgentPreset = 'explore' | 'plan' | 'build' | 'admin';
export type ToolProfile = 'bootstrap' | 'navigate' | 'full' | 'auto';
export type CoderProvider = 'anthropic' | 'openai' | 'openrouter' | 'gemini' | 'bedrock' | 'zai' | 'deepseek' | 'kimi-code' | 'claude-code' | 'cloudflare';

export interface CoderSession {
  id: number;
  project_id: number;
  title: string;
  provider: string;
  model: string;
  model_mode?: string;
  status: string;
  total_input_tokens: number;
  total_output_tokens: number;
  group_id?: number | null;
  is_archived: boolean;
  is_favorite: boolean;
  phase_profile_id?: number | null;
  unrestricted_tool_output?: boolean;
  created_at: string;
  updated_at: string;
}

export interface CreateSessionInput {
  project_id: number;
  title: string;
  provider: CoderProvider;
  model?: string;
  agent?: AgentPreset;
  phase_profile_id?: number | null;
}

export interface UpdateSessionInput {
  title?: string;
  provider?: CoderProvider;
  model?: string;
  model_mode?: string;
  group_id?: number | null;
  is_archived?: boolean;
  is_favorite?: boolean;
  phase_profile_id?: number | null;
  unrestricted_tool_output?: boolean;
}

/**
 * Attachments accepted on the FIRST message of a session (mid-run
 * attachments are rejected by the runner). Shape mirrors the
 * `CoderAttachment` type in @mcp/code-agent.
 */
export interface CoderAttachment {
  type: 'image' | 'document' | 'text';
  filename?: string;
  base64?: string;
  text?: string;
  mediaType?: string;
}

export interface SendMessageInput {
  sessionId: number;
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
  /** Resume from history (last message must be a tool result). */
  resume?: boolean;
}

export interface ContinueSessionInput {
  sessionId: number;
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
  sessionId: number;
  status: string;
  alive: boolean;
  updatedAt: string;
}

export interface ToolCallStats {
  sessionId: number;
  byTool: Array<{ tool: string; count: number; total_ms: number; total_chars: number }>;
  recent: Array<{ tool: string; ts: string; duration_ms: number; chars: number }>;
  savings: { reduced_chars: number; reduced_tokens_est: number };
}

// ─── Sub-namespaces ────────────────────────────────────────

export interface CoderSessionsApi {
  list(input: { projectId?: number; archived?: boolean; favorite?: boolean }, ctx: ApiContext): Promise<CoderSession[]>;
  recent(input: { limit?: number }, ctx: ApiContext): Promise<CoderSession[]>;
  get(input: { id: number; includeMessages?: boolean }, ctx: ApiContext): Promise<{ session: CoderSession; messages?: unknown[] }>;
  create(input: CreateSessionInput, ctx: ApiContext): Promise<CoderSession>;
  update(input: { id: number } & UpdateSessionInput, ctx: ApiContext): Promise<CoderSession>;
  delete(input: { id: number }, ctx: ApiContext): Promise<{ ok: true }>;

  /** Paginated messages (the dashboard chat history). */
  messages(input: { id: number; cursor?: string; limit?: number }, ctx: ApiContext): Promise<{ items: unknown[]; nextCursor: string | null }>;
}

export interface CoderProvidersApi {
  list(input: void, ctx: ApiContext): Promise<unknown[]>;
  get(input: { id: string }, ctx: ApiContext): Promise<unknown>;
  setActive(input: { sessionId: number; provider: CoderProvider; model: string }, ctx: ApiContext): Promise<void>;
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
  attach(input: { sessionId: number; since?: number }, ctx: ApiContext): AsyncStream<CoderEvent>;

  state(input: { sessionId: number }, ctx: ApiContext): Promise<SessionStateInfo>;
  toolStats(input: { sessionId: number; recent?: number }, ctx: ApiContext): Promise<ToolCallStats>;
}

export interface CoderInteractionApi {
  /** Answer an `ask_user` tool prompt. */
  answer(input: { sessionId: number; question_id: string; answer: string }, ctx: ApiContext): Promise<{ ok: true; resumed: boolean }>;

  /** Respond to a `submit_plan` (approve or revise). */
  planResponse(input: { sessionId: number; plan_id: string; decision: 'approve' | 'revise'; feedback?: string }, ctx: ApiContext): Promise<{ ok: true; resumed: boolean }>;

  /** Respond to `submit_tasks`. */
  tasksResponse(input: { sessionId: number; tasks_id: string; decision: 'approve' | 'revise'; feedback?: string }, ctx: ApiContext): Promise<{ ok: true; resumed: boolean }>;
}

export interface CoderGroupsApi {
  list(input: { projectId: number }, ctx: ApiContext): Promise<Array<{ id: number; name: string; project_id: number }>>;
  create(input: { projectId: number; name: string }, ctx: ApiContext): Promise<{ id: number }>;
  update(input: { id: number; name: string }, ctx: ApiContext): Promise<void>;
  delete(input: { id: number }, ctx: ApiContext): Promise<void>;
}

export interface CoderSkillsApi {
  list(input: void, ctx: ApiContext): Promise<unknown[]>;
  get(input: { id: string }, ctx: ApiContext): Promise<unknown>;
  activeForSession(input: { sessionId: number }, ctx: ApiContext): Promise<string[]>;
  setActiveForSession(input: { sessionId: number; skillIds: string[] }, ctx: ApiContext): Promise<void>;
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
