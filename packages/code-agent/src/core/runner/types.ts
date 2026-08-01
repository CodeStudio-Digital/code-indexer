import type { ChatProvider } from '@mcp/code-agent/providers/adapter.js';
import type { ToolRegistry } from '@mcp/code-agent/core/registry.js';
import type { AgentMessage, ChatUsage } from '@mcp/code-agent/core/messages.js';
import type { ToolContext } from '@mcp/code-agent/core/tool.js';
import type { AgentDecisionGuidance, AgentDecisionTelemetry } from '@mcp/code-agent/agents/decision-types.js';
import type { CoderTunables } from '@mcp/code-agent/core/tunables.js';
import type { CoderProfile, ToolTier } from '@mcp/code-agent/tools/tiers.js';
import type { CompactionSummaryV3 } from '@mcp/code-agent/core/summarizer.js';
import type { DispatchArgs } from './nodes/executing-dispatch.js';
import type {
  PolicyShadowPort,
  PolicyShadowSessionContext,
} from '@mcp/code-agent/core/policy-shadow-adapter.js';
import type { SessionId } from '@mcp/session-storage';
import type { FsSessionStore } from '@mcp/code-agent/sessions/fs-store/fs-session-store.js';
import type { FsTurnTelemetrySink } from '@mcp/code-agent/sessions/fs-store/turn-telemetry.js';

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
  | 'provider-thinking-timeout'
  | 'provider-fallback'
  | 'doom-loop-strict'
  | 'doom-loop-fuzzy'
  | 'failure-streak'
  | 'dup-call-cap'
  | 'polling-stuck'
  | 'pre-read-blocked'
  | 'pre-read-allowed-elided'
  | 'pre-read-allowed-mutation'
  | 'pre-read-shadow-allowed'
  | 'pre-read-auto-downgraded'
  | 'pre-read-coverage-pointer'
  | 'pre-read-coverage-degraded'
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
  | 'tool_budget'       // subagent hit its (optional) tool-CALL budget — benign, partial result (not a crash)
  | 'time_budget';      // subagent hit its (optional) wall-clock budget — benign, partial result (not a crash)

export interface RunResult {
  totalUsage: ChatUsage;
  reason: StopReason;
  /** PR-4 — last recovery path taken before stopping, when applicable. */
  transition?: TransitionKind | null;
}

export interface CompactionCheckpoint {
  /** The one V3 result reused for in-memory resume, persistence and harvest. */
  summary: CompactionSummaryV3;
  /** Exact in-memory head summarized before it is replaced. */
  headMessages: AgentMessage[];
  trigger?: string;
  autoContinues: number;
}

export interface CompactionCheckpointResult {
  status: 'committed' | 'compatibility' | 'noop' | 'failed' | 'disabled';
  chapterId?: string | null;
  boundaryId?: number | null;
  reason?: string | null;
}

export interface RunnerOptions {
  provider: ChatProvider;
  /** Optional zero-temperature auxiliary binding; falls back to `provider`. */
  compactionProvider?: ChatProvider;
  /** DB-resolved raw context window. Static registry is only a fallback. */
  contextWindow?: number | null;
  /** Validated config from the code-agent/compaction pipeline binding. */
  compactionSummaryOptions?: {
    timeoutMs?: number;
    budgetChars?: number;
    temperature?: number;
    reasoningEffort?: string | null;
    maxOutputTokens?: number;
  };
  registry: ToolRegistry;
  systemPrompt: string;
  toolContext: ToolContext;
  initialMessages?: AgentMessage[];
  /** Omitted/zero means the top-level run has no turn limit. */
  maxTurns?: number;
  /** Extra batches after maxTurns. Ignored while maxTurns is disabled. */
  maxAutoContinues?: number;
  /** Persistent session id — used only for tagging logs. */
  sessionId?: SessionId;
  /** True for ephemeral subagents. Tags logs as `s=<parentId>/sub`. */
  isSubagent?: boolean;
  /** Parent runner correlation for an ephemeral child. */
  parentRunId?: string;
  /** Stable micro-agent profile id (explore/implement/verify/review/full). */
  subagentProfile?: string;
  /** Plan mode: agent must call submit_plan and get approval before mutating tools. */
  planMode?: boolean;
  /**
   * Fase 2.5 Policy Engine shadow port (default-off). Composed by `runCoder`
   * via `createPolicyShadowPort` when any `CODER_*` policy flag is on;
   * absent by default so the dispatch path stays byte-identical to legacy.
   */
  policyShadow?: DispatchArgs['policyShadow'];
  /**
   * Child-scope compositor over the same policy authority. Unlike passing the
   * root port directly, this binds the child's background mode and task scope.
   */
  policyShadowScopeFactory?: (sessionContext: PolicyShadowSessionContext) => PolicyShadowPort;
  /**
   * Per-run lifecycle HookBus. Absent when CODER_HOOK_BUS_V1 is off, keeping
   * provider/capability/run paths byte-identical to the legacy runtime.
   */
  hookBus?: import('@mcp/code-agent/core/hook-bus.js').HookBus;
  /**
   * Ultra execution identity for this run — 'session' when the sticky
   * execution mode is Ultra, 'turn' when the `ultracode` keyword upgraded
   * only this run. Surfaced in `run_started` so the dashboard renders the
   * Ultra chip; absent for standard runs.
   */
  executionUltra?: 'session' | 'turn';
  /**
   * Plan depth (simple|normal|complex) — surfaced on the runner so the
   * soft-mandatory decision-gate nudge can skip trivial (`simple`) tasks.
   * Resolved by runCoder from opts/session; defaults to 'normal'.
   */
  planDepth?: 'simple' | 'normal' | 'complex';
  /**
   * Spec mode: agent must call `submit_spec` and get human approval before
   * mutating tools. Set by `runCoder` when `agentId === 'spec'`.
   */
  specMode?: boolean;
  /** Override the per-tool-result push-time cap. Subagents pass a tighter value. */
  pushTimeCap?: number;
  /**
   * Tool names whose results should be preserved with a higher inline cap.
   * Used by constrained specialist agents whose small tool surface returns
   * high-value structured context (for example App Studio specs).
   */
  preserveToolOutputNames?: ReadonlySet<string>;
  /** Optional cap for preserved tool outputs. Defaults in runner.ts. */
  preservedToolOutputCap?: number;
  /**
   * Per-session resolved tunables. When omitted, falls back to `envTunables()`
   * (i.e. `process.env.CODER_*` with hardcoded defaults).
   */
  tunables?: CoderTunables;
  /**
   * Per-session tool-output cap LEVEL (economic|medium|high|extra|max|ultra).
   * Resolves `effectivePushTimeCap` via `capFor`; also threads to mcp-bridge /
   * code_exec / read_file through the ToolContext. Undefined → 'economic'.
   * Auto-compaction still runs.
   */
  toolOutputCapLevel?: import('./output-caps.js').ToolOutputCapLevel;
  /**
   * Per-session tool permission mode driving the PermissionGate
   * ('ask' | 'auto' | 'unrestricted'). Null/undefined → 'auto'. Read live by
   * the gate via `getToolPermissionMode()`, so mid-run changes apply to the
   * next gated call. Mirrors the permission mode in `state.json`.
   */
  toolPermissionMode?: 'ask' | 'auto' | 'unrestricted' | null;
  /** Initial set of active tool tiers. Filters tools array each turn. */
  activeTiers?: Set<ToolTier>;
  /**
   * Seed for the runner's pinned-tool set — hidden tools the model called
   * by name in a PRIOR run of this session (re-derived from history on
   * resume AND unioned with the session-persisted pins, mig 142). Pinned
   * tools bypass the tier filter and enter the bounded dynamic working set.
   */
  initialPinnedTools?: Iterable<string>;
  /**
   * Host/configured pins that define the agent's permanent capability floor.
   * Runtime-discovered pins are managed as a bounded LRU working set and may
   * be replaced; required pins never leave the visible catalog because of
   * that replacement policy.
   */
  requiredPinnedTools?: Iterable<string>;
  /**
   * Fired when `expand_toolset` promotes a tier mid-run. The host persists
   * the widen (mig 142) so the next resume rebuilds the SAME tool array —
   * membership must stay byte-stable across runs or the provider
   * prompt-cache prefix busts on the next round's first turn.
   */
  onTierPromoted?: (tier: ToolTier) => void;
  /**
   * Fired whenever bounded runtime-pin membership changes. Receives the
   * runner's exact current set (required pins included); the host persists
   * only the dynamic subset as an exact replacement, so LRU evictions survive
   * crashes and resumes instead of being resurrected by append-only state.
   */
  onPinnedToolsChanged?: (pins: readonly string[]) => void;
  /**
   * Task-preflight seed (fresh sessions only). `preflightHint` is the
   * rendered `<preflight>` block injected on turn 1 and re-injected after
   * compaction; `sessionToolCap` caps the visible tool list at
   * `min(model cap, sessionToolCap)` for the whole session.
  */
  preflightHint?: string;
  sessionToolCap?: number;
  /**
   * Whether this objective must establish and close a durable session goal
   * even before the current-run tool ledger becomes substantive. Derived from
   * validated fresh preflight or a still-pending cached objective on resume.
   */
  goalLifecycleIntent?: import('./goal-lifecycle-intent.js').GoalLifecycleIntent;
  /** Compact Agent Decision Engine guidance for this task/turn, when enabled by the host. */
  agentDecisionGuidance?: AgentDecisionGuidance | null;
  /** Compact Agent Decision Engine telemetry for recommendation-vs-outcome logging. */
  agentDecisionTelemetry?: AgentDecisionTelemetry | null;
  /** Default-off soft guardrail that blocks only high-risk deviations from `agentDecisionGuidance`. */
  agentDecisionSoftGuardrail?: boolean;
  /** Optional confidence threshold for the soft guardrail. Defaults in policy.ts. */
  agentDecisionSoftGuardrailMinConfidence?: number;
  /** Default-off UX gate: ask before switching when guidance confidently recommends another agent. */
  agentDecisionAskBeforeSwitch?: boolean;
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
      /** Pins must survive relevance selection just like the model/tool cap. */
      protectedToolNames?: ReadonlySet<string>;
      /** Filesystem owner for session-scoped shadow telemetry. */
      sessionId?: SessionId;
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
  /** Opaque Company agent-run UUID — populated for Company subordinates. */
  companyAgentRunId?: string | null;
  /** Opaque Company filesystem-session UUID — populated for Company agents. */
  companySessionId?: string | null;
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
   * Mem C — optional LLM synthesizer that rewrites a meta/continuation message
   * into a real memory-recall query from the conversation tail. Returns null
   * when unconfigured → the Executing node falls back to the walk-back
   * heuristic. Unset entirely = heuristic only (no LLM synthesis).
   */
  synthesizeMemoryQuery?: (
    tail: ReadonlyArray<{ role: 'user' | 'assistant'; text: string }>,
  ) => Promise<string | null>;
  /**
   * True when this session has active (un-kept/un-reverted) file snapshots
   * worth a self-review. Consulted each turn by the dynamic-injection node to
   * decide whether to surface the `self_review` reminder — gated by the
   * CODER_SELF_REVIEW toggle. Unset = no reminder (and tests stay quiet).
   */
  hasReviewableChanges?: () => boolean | Promise<boolean>;
  /**
   * Fix A — richer self_review nudge signals (supersedes `hasReviewableChanges`
   * for the nudge decision). Lets the Executing node nudge ONLY when there are
   * UNREVIEWED changes, instead of every turn with any pending snapshot (which
   * is forever, since `self_review` never closes snapshots — the session-887
   * doom-loop). Host reads the snapshot + review stores; unset on
   * subagents/tests → the node falls back to `hasReviewableChanges`.
   */
  collectSelfReviewSignals?: () => ({
    /** `${activeBaselineCount}:${maxLastEditedAtMs}`; '' when no active snapshots. */
    pendingFingerprint: string;
    /** ms-epoch of the newest active snapshot edit, or null when none. */
    lastEditAt: number | null;
    /** ms-epoch of the most recent completed auto self_review, or null. */
    lastReviewAt: number | null;
    /** total completed auto self_reviews this session (drives the hard-stop). */
    totalAutoReviews: number;
  } | null) | Promise<{
    pendingFingerprint: string;
    lastEditAt: number | null;
    lastReviewAt: number | null;
    totalAutoReviews: number;
  } | null>;
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
  /** Titles-only index of immutable summaries for this coder session. */
  getConversationChapterIndex?: () => Promise<{
    total: number;
    entries: ReadonlyArray<{ id: string; ordinal: number; title: string; source?: string }>;
  } | null>;
  /** Up to two bounded excerpts for a materially new task in this session. */
  getRelevantConversationChapters?: (
    taskText: string,
    turn: number,
  ) => Promise<ReadonlyArray<{ id: string; title: string; content: string }>>;
  /** Best-effort durable checkpoint for a successfully produced V3 summary. */
  onCompactionCheckpoint?: (checkpoint: CompactionCheckpoint) => Promise<CompactionCheckpointResult>;
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
  /** Filesystem session runtime used for lifecycle/input/task persistence. */
  sessionStore?: FsSessionStore;
  /** Immutable per-turn filesystem telemetry; there is no SQLite fallback. */
  turnTelemetryStore?: FsTurnTelemetrySink;
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
  /** Enable completion-evidence collection for advisory health reporting. */
  verificationEvidenceEnabled?: boolean;
  /** Persisted cross-run verification evidence; current-run ordering uses ToolCallLedger. */
  collectVerifyEvidence?: () =>
    | import('@mcp/code-agent/core/review-evidence.js').VerifyEvidence
    | null
    | Promise<import('@mcp/code-agent/core/review-evidence.js').VerifyEvidence | null>;
  /**
   * Independent goal-completion reviewer (host-built closure). The bridge
   * schedules it after update_goal(complete) is durable. Its verdict is audit
   * data only and null means inconclusive.
   */
  verifyGoalCompletion?: (
    evidence?: import('./nodes/executing-verification-gate.js').VerificationReadiness,
  ) => Promise<{
    goalMet: boolean;
    gaps: ReadonlyArray<{ description: string; severity: string }>;
  } | null>;
  /**
   * Host-owned durability barrier at an Executing turn boundary. The runner
   * emits `turn_start` first so the host can enqueue the previous turn's
   * transcript/goal transaction, then awaits this callback before invoking
   * the provider. A rejection is execution authority: the BT fails closed and
   * no provider or tool from the new turn may run.
   */
  awaitTurnPersistence?: () => Promise<void>;
}
