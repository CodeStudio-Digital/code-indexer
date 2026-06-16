import type { ChatProvider } from '@mcp/code-agent/providers/adapter.js';
import type { ToolRegistry } from '@mcp/code-agent/core/registry.js';
import type { AgentMessage, ChatUsage } from '@mcp/code-agent/core/messages.js';
import type { ToolContext } from '@mcp/code-agent/core/tool.js';
import type { CoderTunables } from '@mcp/code-agent/core/tunables.js';
import type { CoderProfile, ToolTier } from '@mcp/code-agent/tools/tiers.js';

/**
 * Recovery transition kinds (PR-4, Row 3 from
 * docs/agent-research/COMPARISON.md). Recorded on the runner whenever a
 * recovery path is taken so the eventual `done` event carries an attribution
 * trail. Mirrors claude-code's `state.transition.reason` watermark.
 */
export type TransitionKind =
  | 'compact-pre-turn'
  | 'compact-auto-continue'
  | 'provider-400-retry'
  | 'provider-401-refresh'
  | 'provider-transient-retry'
  | 'provider-fallback'
  | 'doom-loop-strict'
  | 'doom-loop-fuzzy'
  | 'failure-streak'
  | 'dup-call-cap'
  | 'result-dup-cap'
  | 'pre-read-blocked'
  | 'pre-read-allowed-elided'
  | 'pre-read-allowed-mutation'
  | 'pre-read-auto-downgraded'
  | 'pre-read-force-reread'
  | 'stop-guard-nudge'
  | 'tool-timeout';

/**
 * Stop reasons (PR-4, Row 2). Superset of the original 5 — additions are
 * specific failure/abort modes the legacy 'error'/'aborted' lumped together.
 */
export type StopReason =
  | 'completed'
  | 'max_turns'
  | 'aborted'
  | 'error'
  | 'plan_required'
  | 'recovery_capped'   // a recovery-path circuit breaker (PR-2 R1) tripped
  | 'doom_loop'         // doom-loop guard refused identical tool calls
  | 'compact_failure'   // consecutive compaction failures hit the cap
  | 'compact_exhausted' // pre-emit compaction kept firing without freeing the window
  | 'tool_budget';      // subagent hit its (optional) tool-CALL budget — benign, partial result (not a crash)

export interface RunResult {
  totalUsage: ChatUsage;
  reason: StopReason;
  /** PR-4 — last recovery path taken before stopping, when applicable. */
  transition?: TransitionKind | null;
}

export interface RunnerOptions {
  provider: ChatProvider;
  registry: ToolRegistry;
  systemPrompt: string;
  toolContext: ToolContext;
  initialMessages?: AgentMessage[];
  maxTurns?: number;
  /** Persistent session id — used only for tagging logs. */
  sessionId?: number;
  /** True for ephemeral subagents. Tags logs as `s=<parentId>/sub`. */
  isSubagent?: boolean;
  /** Plan mode: agent must call submit_plan and get approval before mutating tools. */
  planMode?: boolean;
  /**
   * Spec mode: agent must call `submit_spec` and get human approval before
   * mutating tools. Set by `runCoder` when `agentId === 'spec'`.
   */
  specMode?: boolean;
  /** Override the per-tool-result push-time cap. Subagents pass a tighter value. */
  pushTimeCap?: number;
  /**
   * Per-session resolved tunables. When omitted, falls back to `envTunables()`
   * (i.e. `process.env.CODER_*` with hardcoded defaults).
   */
  tunables?: CoderTunables;
  /**
   * Per-session "unrestricted tool output" toggle. Bumps `effectivePushTimeCap`
   * to the high safety ceiling. Auto-compaction still runs.
   */
  unrestrictedToolOutput?: boolean | null;
  /**
   * Per-session tool permission mode driving the PermissionGate
   * ('ask' | 'auto' | 'unrestricted'). Null/undefined → 'auto'. Read live by
   * the gate via `getToolPermissionMode()`, so mid-run changes apply to the
   * next gated call. Mirrors `coder_sessions.tool_permission_mode`.
   */
  toolPermissionMode?: 'ask' | 'auto' | 'unrestricted' | null;
  /** Initial set of active tool tiers. Filters tools array each turn. */
  activeTiers?: Set<ToolTier>;
  /**
   * Seed for the runner's pinned-tool set — hidden tools the model called
   * by name in a PRIOR run of this session (re-derived from history on
   * resume AND unioned with the session-persisted pins, mig 142). Pinned
   * tools bypass the tier filter and survive the model's maxTools cap.
   */
  initialPinnedTools?: Iterable<string>;
  /**
   * Fired when `expand_toolset` promotes a tier mid-run. The host persists
   * the widen (mig 142) so the next resume rebuilds the SAME tool array —
   * membership must stay byte-stable across runs or the provider
   * prompt-cache prefix busts on the next round's first turn.
   */
  onTierPromoted?: (tier: ToolTier) => void;
  /**
   * Task-preflight seed (fresh sessions only). `preflightHint` is the
   * rendered `<preflight>` block injected on turn 1 and re-injected after
   * compaction; `sessionToolCap` caps the visible tool list at
   * `min(model cap, sessionToolCap)` for the whole session.
   */
  preflightHint?: string;
  sessionToolCap?: number;
  /**
   * Profile shorthand — expanded into `activeTiers` if not explicitly set.
   * 'bootstrap' → ~13 essentials; 'navigate' adds edit/git read; 'full' adds admin.
   */
  profile?: CoderProfile;
  /** Tools globally disabled via admin panel. Applied before tier filtering. */
  globalDisabledTools?: ReadonlySet<string>;
  /** Tools disabled for this specific session. Applied before tier filtering. */
  sessionDisabledTools?: ReadonlySet<string>;
  /**
   * Optional opt-in filter for the per-turn tool list (ToolSelectionPipeline).
   *
   * Contract:
   *   - Called AFTER tier/disabled filtering, BEFORE serializing tools.
   *   - Receives the SERIALIZED tool shape (name/description/parameters).
   *   - Must return a non-empty subset of the input.
   *   - Must never throw — failures default to the unfiltered list.
   */
  toolSelectionFilter?: (
    tools: Array<{ name: string; description: string; parameters: import('../tool.js').JsonSchema }>,
    ctx: {
      taskText: string;
      recentToolCalls: ReadonlyArray<{ name: string; timestampMs: number; ok: boolean }>;
    },
  ) => Promise<Array<{ name: string; description: string; parameters: import('../tool.js').JsonSchema }>>;
  /**
   * Runtime tier overrides for external MCP tools. Maps tool name (e.g.
   * `ext_github__create_issue`) to its tier.
   */
  externalToolTiers?: ReadonlyMap<string, ToolTier>;
  /** Enable thinking/reasoning mode for providers that support it. */
  thinking?: boolean;
  /**
   * Explicit reasoning-effort level (e.g. `minimal`/`low`/`medium`/`high`/`xhigh`).
   * Orthogonal to `thinking`. Resolved by runCoder from the session sticky
   * override (single) or the role/master config (company) and forwarded to the
   * provider via `ChatRequest.reasoningEffort`. Undefined → provider default.
   */
  reasoningEffort?: string;
  /**
   * Vision fallback. `modelSupportsVision === false` (strict) means the active
   * model can't consume images → the runner routes image blocks through the
   * configured vision model for a text description. `describeImages` is the
   * composer "Describe images" flag that FORCES the same path even on a
   * vision-capable model (e.g. to get a textual layout spec). Both undefined →
   * disabled (no surprise cost).
   */
  modelSupportsVision?: boolean;
  describeImages?: boolean;
  /**
   * Per-request thinking budget (in tokens). Only meaningful for providers
   * whose extended-thinking surface accepts a budget (Anthropic).
   */
  thinkingBudgetTokens?: number;
  /** Fallback chain for automatic provider recovery on persistent errors. */
  fallbackChain?: import('@mcp/code-agent/core/fallback.js').FallbackChain;
  /** Factory function to create a new provider for fallback. */
  createProvider?: (name: string, model: string) => Promise<ChatProvider>;
  /** Runtime hook registry for lifecycle events. */
  hookRegistry?: import('@mcp/code-agent/core/hook-registry.js').RuntimeHookRegistry;
  /** Pre-resolved context window for this session's model (tokens). */
  context_window?: number | null;
  /** When true, periodically inject a reminder to post a deliverable before stopping. */
  isCompanySubordinate?: boolean;
  /** Role identity text from template's systemPromptOverride. Re-injected as user message reminder. */
  companyRoleOverride?: string;
  /** Company agent_run_id — populated for company subordinates. */
  companyAgentRunId?: number | null;
  /** Company session id — populated for company subordinates. */
  companySessionId?: number | null;
  /** Stateful Responses API: previous response identifier. */
  previousResponseId?: string | null;
  /** Companion to `previousResponseId` — number of messages already on the server. */
  previousResponseMessageCount?: number | null;
  /** Callback fired when the provider returns a new response.id. */
  onResponseId?: (responseId: string, messageCount: number) => void;
  /**
   * Mem C — host-provided retrieval of relevant project memory for the
   * current task. The host closes over a MemoryRetriever + the session's
   * project, returning already relevance-gated + ranked items. Unset =
   * proactive memory injection disabled.
   */
  getRelevantProjectMemory?: (
    taskText: string,
    turn: number,
  ) => Promise<ReadonlyArray<{ id: string; title: string; content: string; staleNote?: string }>>;
  /**
   * True when this session has active (un-kept/un-reverted) file snapshots
   * worth a self-review. Consulted each turn by the dynamic-injection node to
   * decide whether to surface the `self_review` reminder — gated by the
   * CODER_SELF_REVIEW toggle. Unset = no reminder (and tests stay quiet).
   */
  hasReviewableChanges?: () => boolean;
  /**
   * Fix A — richer self_review nudge signals (supersedes `hasReviewableChanges`
   * for the nudge decision). Lets the Executing node nudge ONLY when there are
   * UNREVIEWED changes, instead of every turn with any pending snapshot (which
   * is forever, since `self_review` never closes snapshots — the session-887
   * doom-loop). Host reads the snapshot + review stores; unset on
   * subagents/tests → the node falls back to `hasReviewableChanges`.
   */
  collectSelfReviewSignals?: () => {
    /** `${activeBaselineCount}:${maxLastEditedAtMs}`; '' when no active snapshots. */
    pendingFingerprint: string;
    /** ms-epoch of the newest active snapshot edit, or null when none. */
    lastEditAt: number | null;
    /** ms-epoch of the most recent completed auto self_review, or null. */
    lastReviewAt: number | null;
    /** total completed auto self_reviews this session (drives the hard-stop). */
    totalAutoReviews: number;
  } | null;
  /**
   * Session State Block data — host-provided sync read of the session's
   * persisted state (goal, active plan, todos, notes, changed files,
   * investigation count). The Executing node renders + injects it per the
   * window-scaled policy (`assembly/injection-policy.ts`) so continuity never
   * depends on summarization alone. Unset (company sessions, tests) = off.
   */
  getSessionStateData?: () => {
    goal: { text: string; status: string } | null;
    activePlan: { text: string; status: string } | null;
    todos: ReadonlyArray<{ status: string; label: string }>;
    notes: ReadonlyArray<{ id: string; title: string; body: string; kind: string; pinned: boolean }>;
    filesChanged: ReadonlyArray<string>;
    investigationCount: number;
  } | null;
  /**
   * Project memory index (MEMORY.md-style top-N titles) — injected at
   * turn 1 / post-compaction so the session knows what the project already
   * learned (full bodies via the recall_memory tool). Unset = off.
   */
  getProjectMemoryIndex?: () => ReadonlyArray<{ title: string; category: string }> | null;
  /**
   * Global user-preferences index (migration 145) — top-N user/feedback
   * memories injected into every project, NOT gated by the project toggle.
   */
  getUserMemoryIndex?: () => ReadonlyArray<{ title: string; category?: string; excerpt?: string }> | null;
  /**
   * Phase 2 hardening: explicit escape hatch for admin-level operations.
   * Today the runner constructs the policy context with `strict: false`.
   */
  adminOverride?: boolean;
  /** Active agent preset — drives `defaultTemperature` lookup. */
  agentId?: import('@mcp/code-agent/agents/index.js').AgentId | null;
  /** Per-session temperature override. */
  sessionTemperature?: number | null;
  /** Per-role temperature override (company mode). */
  roleTemperature?: number | null;
  /** SessionStore — when present, lifecycle injections get mirrored into `coder_session_inputs`. */
  sessionStore?: import('@mcp/code-agent/sessions/store.js').SessionStore;
  /**
   * SkillStore — resolves each `selectedSkillIds` entry and injects bodies
   * as `<active_skills>` each turn.
   */
  skillStore?: import('@mcp/store/skill-store.js').SkillStore;
  /**
   * Agent Loop v2 — opt-in to live `<active-context>` injection per turn,
   * the stop-guard, and the auto-continue recap.
   */
  agentLoopV2?: boolean;
}
