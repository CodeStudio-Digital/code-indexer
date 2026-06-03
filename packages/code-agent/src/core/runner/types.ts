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
  | 'compact_exhausted'; // pre-emit compaction kept firing without freeing the window

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
  /** Initial set of active tool tiers. Filters tools array each turn. */
  activeTiers?: Set<ToolTier>;
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
  /**
   * Simulated deep-thinking — orthogonal to `thinking`. When true, BEFORE
   * each main-model turn the runner asks a cheaper auxiliary model for
   * inner reasoning, then prefills an `<thinking data-source="aux">…</thinking>`
   * block. Independent of `thinking`: both can be on, both can be off.
   */
  deepThink?: boolean;
  /** Model id for the auxiliary pre-think call. Default 'claude-haiku-4-5-20251001'. */
  deepThinkModel?: string;
  /** Provider name for the auxiliary call. Default 'anthropic'. */
  deepThinkProvider?: string;
  /** When false (default), skip pre-think on tool_result turns. */
  preThinkOnToolResults?: boolean;
  /** Hard timeout for the auxiliary call (ms). Default 8000. */
  preThinkTimeoutMs?: number;
  /**
   * Persist injected `<thinking data-source="aux">` blocks so future turns
   * see accumulated reasoning. Default true.
   */
  persistPreThoughts?: boolean;
  /** How many pre-think blocks to keep in history. Default 3. */
  preThinkHistoryWindow?: number;
  /** Minimum approx token count of last user input to fire pre-think. Default 0. */
  preThinkMinInputTokens?: number;
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
  ) => Promise<ReadonlyArray<{ id: string; title: string; content: string }>>;
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
