import { EventEmitter } from 'node:events';
import { randomUUID, createHash } from 'node:crypto';
import { resolve as pathResolve, relative as pathRelative, isAbsolute } from 'node:path';
import { statSync as fsStatSync } from 'node:fs';
import type { ChatProvider } from '../providers/adapter.js';
import type { ToolRegistry } from './registry.js';
import type { AgentMessage, ChatDelta, ChatUsage, ContentBlock, ToolUseBlock, PlanBlock, QuestionBlock, ToolResultBlock } from './messages.js';
import type { ToolContext } from './tool.js';
import {
  compactMessages,
  PRUNE_PROTECT,
  computeCutoffIndex,
  recedeToPreserveLastNTurns,
  totalChars,
  PRUNE_MINIMUM,
  snapCutoffToRoleBoundary,
  snapCutoffPreservingPairs,
  computeCutoffIndexByTokens,
  deriveCompactionLimits,
  deriveTokenLimits,
  shouldCompact as shouldCompactTokens,
  isNewCompactionEnabled,
  postCompactCleanup,
  applyRollingReduction,
  REDUCIBLE_READ_TOOLS,
  buildReadDedupKey,
  getStringField,
  isMutatingFsTool,
  allPriorReadsElided,
  lastMutationTurn,
  findToolResultByUseId,
  extractReadPreview,
  buildSimpleLineDiff,
  buildRichRefusal,
  buildAutoDowngradeResponse,
} from "./compaction.js";
import { evaluateToolInvocation, findScopeViolations, isIrreversibleTool, type PolicyContext } from './policy.js';
import { AGENTS } from '../agents/index.js';
import { isSummarizerEnabled, summarizeSpan, summarizeSpanV2, renderSummary, renderSummaryV2, isStructuredSummaryEnabled, overlayLiveState } from './summarizer.js';
import { computeSnapshot, type TokenSnapshot } from './token-accounting.js';
import { filterByTiers, profileToTiers, type ToolTier, type CoderProfile } from '../tools/tiers.js';
import { terseDescription } from '../tools/descriptions.js';
import { applySmartReducer } from './smart-reducers.js';
import { getModelContextWindow, getModelMaxTools, getEffectiveContextWindow } from '../providers/capabilities.js';
import { runToolFilterHook } from './hooks.js';
import { resolveTemperature } from '../inference/temperature.js';
import { estimateCost } from '../providers/pricing.js';
import { buildActiveContextBlock } from './active-context.js';

/**
 * Recovery transition kinds (PR-4, Row 3 from
 * docs/agent-research/COMPARISON.md). Recorded on the runner whenever a
 * recovery path is taken so the eventual `done` event carries an
 * attribution trail. Mirrors claude-code's `state.transition.reason`
 * watermark in `query.ts`.
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
  | 'dup-call-cap'
  | 'result-dup-cap'
  | 'pre-read-blocked'
  | 'pre-read-allowed-elided'
  | 'pre-read-allowed-mutation'
  | 'pre-read-auto-downgraded'
  | 'stop-guard-nudge';

/**
 * Stop reasons (PR-4, Row 2). Superset of the original 5 — additions are
 * specific failure/abort modes the legacy 'error'/'aborted' lumped together.
 * Existing consumers that only branch on `'completed'` keep working; new
 * dashboards/billing can attribute cost to specific failure modes.
 */
export type StopReason =
  // Original (preserve binary compatibility):
  | 'completed'
  | 'max_turns'
  | 'aborted'
  | 'error'
  | 'plan_required'
  // PR-4 additions:
  | 'recovery_capped'   // a recovery-path circuit breaker (PR-2 R1) tripped
  | 'doom_loop'         // doom-loop guard refused identical tool calls
  | 'compact_failure';  // consecutive compaction failures hit the cap

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
  /** Persistent session id — used only for tagging logs so concurrent runs are distinguishable. */
  sessionId?: number;
  /** True for ephemeral subagents (spawn_subagent / spawn_agents). Tags logs as `s=<parentId>/sub`. */
  isSubagent?: boolean;
  /** Plan mode: agent must call submit_plan and get approval before mutating tools. */
  planMode?: boolean;
  /** Override the per-tool-result push-time cap. Subagents pass a tighter value. */
  pushTimeCap?: number;
  /**
   * Per-session "unrestricted tool output" toggle. When true, the
   * `effectivePushTimeCap` member is bumped to the high safety ceiling
   * (`UNRESTRICTED_PUSH_TIME_CAP` for main runners, `UNRESTRICTED_SUBAGENT_PUSH_TIME_CAP`
   * for subagents) instead of the production defaults. Auto-compaction
   * still runs. Mirrors `coder_sessions.unrestricted_tool_output`.
   */
  unrestrictedToolOutput?: boolean | null;
  /**
   * Initial set of active tool tiers. When set, the runner filters its tools
   * array each turn to only those whose tier is active. The agent can unlock
   * higher tiers mid-session via the `expand_toolset` tool. Default: all
   * tiers active (backwards-compatible behaviour, no filtering).
   */
  activeTiers?: Set<ToolTier>;
  /**
   * Profile shorthand — expanded into `activeTiers` if `activeTiers` is not
   * explicitly set. 'bootstrap' only exposes the ~13 essential tools on the
   * first turn; 'navigate' adds edit/git read/local nav; 'full' adds admin.
   */
  profile?: CoderProfile;
  /** Tools globally disabled via admin panel. Applied before tier filtering. */
  globalDisabledTools?: ReadonlySet<string>;
  /** Tools disabled for this specific session. Applied before tier filtering. */
  sessionDisabledTools?: ReadonlySet<string>;
  /**
   * Runtime tier overrides for external MCP tools. Maps tool name (e.g.
   * `ext_github__create_issue`) to its tier. Passed through to filterByTiers
   * so external tools respect tier filtering without polluting the static Sets.
   */
  externalToolTiers?: ReadonlyMap<string, ToolTier>;
  /** Enable thinking/reasoning mode for providers that support it (Gemini thinkingConfig). */
  thinking?: boolean;
  /** Fallback chain for automatic provider recovery on persistent errors. */
  fallbackChain?: import('./fallback.js').FallbackChain;
  /** Factory function to create a new provider for fallback. */
  createProvider?: (name: string, model: string) => Promise<ChatProvider>;
  /** Runtime hook registry for lifecycle events (tool calls, errors, fallback, completion). */
  hookRegistry?: import('./hook-registry.js').RuntimeHookRegistry;
  /**
   * Pre-resolved context window for this session's model (tokens).
   * Resolved from the provider_models DB row at session start so the value
   * is DB-accurate even for models not in the static registry.
   */
  context_window?: number | null;
  /**
   * When true, the runner periodically injects a reminder to post a deliverable
   * to the board before stopping. Set for company subordinate agents.
   */
  isCompanySubordinate?: boolean;
  /**
   * Role identity text from the template's systemPromptOverride. When set, re-injected
   * as a user message reminder alongside the deliverable reminder to survive compaction.
   */
  companyRoleOverride?: string;
  /**
   * Stateful Responses API: identifier of the previous response (for ChatGPT/Codex
   * sessions running with `store: true`). When set, the provider sends only the
   * message delta and lets the backend reconstruct the prefix from the stored
   * response. Updated turn-by-turn via `onResponseId`.
   */
  previousResponseId?: string | null;
  /** Companion to `previousResponseId` — number of messages already on the server. */
  previousResponseMessageCount?: number | null;
  /**
   * Callback fired when the provider returns a new response.id (currently only
   * ChatGPT/Codex with `store: true`). The caller persists the id in
   * `coder_sessions.last_response_id` so subsequent turns can replay it.
   */
  onResponseId?: (responseId: string, messageCount: number) => void;
  /**
   * Phase 2 hardening: explicit escape hatch for admin-level operations
   * outside plan mode. The policy module (core/policy.ts) consults this
   * when `strict` is on. Today the runner constructs the policy context
   * with `strict: false` so this flag is reserved — flipping `strict` to
   * `true` (Phase 5) makes `adminOverride` the gate that lets execute /
   * admin tools run without going through plan-mode approval.
   */
  adminOverride?: boolean;
  /**
   * Active agent preset — drives `defaultTemperature` lookup in
   * `resolveTemperature()`. When unset, the resolver falls through to the
   * global default (or to session/role overrides if present).
   */
  agentId?: import('../agents/index.js').AgentId | null;
  /** Per-session temperature override (`coder_sessions.temperature_override`). */
  sessionTemperature?: number | null;
  /** Per-role temperature override (`CompanyRoleConfig.temperature`, company mode). */
  roleTemperature?: number | null;
  /**
   * SessionStore — when present, lifecycle injections (system reminders,
   * sub-agent prompts spawned via execute_task) get mirrored into
   * `coder_session_inputs` for the Input tab. Optional so tests don't
   * need to wire a real DB.
   */
  sessionStore?: import('../sessions/store.js').SessionStore;
  /**
   * Agent Loop v2 — opt-in to the live <active-context> injection per turn,
   * the stop-guard, and the auto-continue recap. Set per-session at
   * creation time so existing in-flight sessions keep their original
   * behavior on resume. See system-prompt.ts for the static-prompt half.
   */
  agentLoopV2?: boolean;
}

// Plan-mode mutating-tool block has moved to `core/policy.ts` (Phase 2).
// Each tool now declares `mutates: true` on its definition; the policy
// module also has a built-in classifier for tools that don't declare it
// yet. `run_command` keeps its granular allowlist inside `tools/shell.ts`
// (which permits the read-only subset during plan mode) — the policy
// only blocks the write/git-mutating set, matching legacy behaviour.

/**
 * Tunables (env-overridable for runtime tuning without rebuild).
 *
 * Frente A redesign: elision is now MONOTONE — applied at push-time with a
 * deterministic marker. Once a block is truncated, its content never changes
 * across turns, which keeps the prompt prefix bit-stable and lets the
 * server-side prompt cache (ZAI/GLM auto cache + Anthropic ephemeral) hit
 * reliably from turn 2 onward.
 *
 * The legacy sliding-window logic (KEEP_LAST_TOOL_TURNS, HARD_CAP_CHARS) is
 * removed because it mutated old blocks every turn, busting the cache.
 */
const PUSH_TIME_CAP = Number(process.env.CODER_PUSH_TIME_CAP ?? 24_000);
/** Tighter per-block cap used inside subagents — they accumulate many small
 *  tool results in a short window, so a 12k cap fits ~10 turns under the budget. */
const SUBAGENT_PUSH_TIME_CAP = Number(process.env.CODER_SUBAGENT_PUSH_TIME_CAP ?? 12_000);
/**
 * "Unrestricted tool output" ceilings — picked when a session has
 * `unrestricted_tool_output = 1`. Deliberately NOT `Infinity` so that
 * the marker arithmetic (`content.length - cap`) and the `toolOutputStore.put`
 * gate keep working even on pathological outputs. Auto-compaction still
 * fires above PRUNE_MINIMUM (60k) so this is not a context-window bypass —
 * it just lifts the per-tool-call ceiling so individual MCP/Unity outputs
 * arrive intact in the turn that produced them.
 */
const UNRESTRICTED_PUSH_TIME_CAP = Number(process.env.CODER_UNRESTRICTED_PUSH_TIME_CAP ?? 1_000_000);
const UNRESTRICTED_SUBAGENT_PUSH_TIME_CAP = Number(
  process.env.CODER_UNRESTRICTED_SUBAGENT_PUSH_TIME_CAP ?? 500_000,
);
/** Per-turn safety budget — emits a warning when the about-to-send payload exceeds this. */
const TURN_BUDGET_CHARS = Number(process.env.CODER_TURN_BUDGET_CHARS ?? 30_000);
/**
 * Doom-loop guard: if the model emits the exact same set of tool calls this
 * many turns in a row, abort the run. Prevents cost blowups when a model
 * latches onto a failing tool call and keeps retrying it verbatim. Set to 0
 * (or any N<2) to disable. Default 3 matches opencode's processor.ts.
 *
 * Default 3 (was 0/disabled): a real session that hit `get_goal` repeatedly
 * 30+ times burned through tokens with no guard. Strict-sig threshold of 3
 * is conservative — only triggers on byte-identical tool calls.
 */
/**
 * Lazy env reader so tests can override these caps after module import
 * (vi.stubEnv works because we re-resolve every call rather than capturing
 * at module load).
 */
function envInt(name: string, fallback: number): number {
  const v = process.env[name];
  if (v != null && v !== '') {
    const n = Number(v);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return fallback;
}
function doomLoopThreshold(): number { return envInt('CODER_DOOM_LOOP_THRESHOLD', 3); }
/**
 * Fuzzy doom-loop threshold: catches "same tool names, slightly different args"
 * patterns that the strict signature misses (e.g., agent keeps calling
 * `read_file` with subtly different line ranges, or `edit_file` with tweaked
 * replacements that never land). Higher than the strict threshold because the
 * false-positive risk is larger — a legitimate iterative workflow may legally
 * call the same tool set many turns in a row.
 *
 * Default 6 (was 0): more tolerant than strict, still catches the
 * "model paginates the same file 6+ turns" pattern. Tweak via env.
 */
const DOOM_LOOP_FUZZY_THRESHOLD = Number(process.env.CODER_DOOM_LOOP_FUZZY_THRESHOLD ?? 6);

/**
 * Per-arg duplicate-call cap (Fix F — session 609 regression). The fuzzy
 * guard above only catches identical tool *names* in a row; it misses
 * cycles where the model rotates 5 different read_file slices and the
 * names sig stays constant but the strict sig keeps changing. This cap
 * tracks how many times each (toolName#argHash) has been called in a
 * rolling window — when a single arg is repeated DUP_CALL_THRESHOLD
 * times we refuse the call inline with a synthetic error result, so
 * the model gets a clear nudge to change strategy without the runner
 * having to abort the whole session.
 *
 * Default 5: balances "agent legitimately re-reads after editing"
 * (1–2 calls) against "agent stuck rotating chunks" (>>5).
 */
const DUP_CALL_THRESHOLD = Number(process.env.CODER_DUP_CALL_THRESHOLD ?? 5);
const DUP_CALL_WINDOW = Number(process.env.CODER_DUP_CALL_WINDOW ?? 20);

/**
 * Polling-tool name pattern. Matches `wait_for_*`, `await_*`, `poll_*`,
 * `tail_*`, `monitor_*` either at the start of the name OR after the
 * `__` separator that mcp-server-manager injects (so e.g.
 * `ext_unity__wait_for_compile_clean` matches). Tools whose names match
 * this pattern OR whose `CoderTool.repeatable` is `true` are exempt from:
 *   - the per-arg dup-call cap (Fix F)
 *   - the strict and fuzzy doom-loop guards
 *   - the dominance guard
 *   - the post-call result-content dedup
 * Repeated identical calls are the legitimate workflow for these tools.
 */
const REPEATABLE_NAME_PATTERN = /(?:^|__)(?:wait_for|await|poll|tail|monitor)_/;

/**
 * Agent Loop v2 result-content dedup. Refuses a tool result that has the
 * same byte content as a previous result from the same tool within the
 * window. Threshold = how many earlier matches in the window before the
 * NEXT call gets refused (default 1 — second duplicate is enough). Min
 * chars guards against tiny no-op outputs like "" or "ok" tripping the
 * cap on legitimate repeat tool calls (e.g. workflow status pings).
 */
const RESULT_DUP_THRESHOLD = Number(process.env.CODER_RESULT_DUP_THRESHOLD ?? 1);
const RESULT_DUP_WINDOW = Number(process.env.CODER_RESULT_DUP_WINDOW ?? 15);
const RESULT_DUP_MIN_CHARS = Number(process.env.CODER_RESULT_DUP_MIN_CHARS ?? 50);

/**
 * PR-5 (Row 32 from docs/agent-research/COMPARISON.md): pre-read enforcement.
 * Refuses BEFORE dispatch when a read-family tool (read_file, mcp__read_file,
 * mcp__get_file_skeleton, mcp__get_file_structure) is called with the SAME
 * path + slice fields seen recently. Tighter than the generic dup-call cap
 * (which fires only on the 5th identical call) and proactive — saves the
 * round-trip the result-dup cap would otherwise burn. Lazy-resolved so tests
 * can override.
 */
function readDupThreshold(): number {
  const v = process.env.CODER_READ_DUP_THRESHOLD;
  if (v != null && v !== '') {
    const n = Number(v);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return 2; // refuse on the SECOND identical (path,slice) read
}
function readDupWindow(): number {
  const v = process.env.CODER_READ_DUP_WINDOW;
  if (v != null && v !== '') {
    const n = Number(v);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return 20;
}

/**
 * Auto-downgrade toggle. When enabled, the pre-read guard returns a
 * skeleton-style summary instead of a hard refusal. Default off — refusal
 * with rich payload is more pedagogical and avoids masking the "model is
 * stuck re-reading" signal. Set CODER_READ_AUTO_DOWNGRADE=1 to opt in.
 */
function readAutoDowngradeEnabled(): boolean {
  return process.env.CODER_READ_AUTO_DOWNGRADE === '1';
}

/**
 * Per-recovery-path circuit breaker (PR-2, R1 from
 * docs/agent-research/COMPARISON.md). Each recovery KIND has its own
 * lifetime cap so a misbehaving server can't repeatedly trigger the same
 * recovery path and balloon billing. Counts persist for the entire session
 * (not reset on turn boundary) — the abuse pattern we are blocking is
 * "this session has burned 6 OAuth refreshes, something is wrong".
 *
 * Distinct from the per-turn `transientRetries` counter that drives R5's
 * exp+jitter retry — a single turn may issue a few transient retries; the
 * circuit breaker only fires when this happens turn after turn.
 */
const RECOVERY_KINDS = [
  'provider-400-retry',
  'provider-401-refresh',
  'provider-transient-retry',
  'provider-fallback',
  'compact-failure',
] as const;
type RecoveryKind = typeof RECOVERY_KINDS[number];

/**
 * Caps are read lazily from env each time tryRecord runs so tests can
 * mutate process.env after the runner module is loaded. Defaults below.
 */
const RECOVERY_CAP_DEFAULTS: Record<RecoveryKind, number> = {
  'provider-400-retry': 3,
  'provider-401-refresh': 2,
  // Transient (429/5xx/timeout) — large cap because R5 already bounds per
  // turn; this catches "every turn for 20 turns gets one 429".
  'provider-transient-retry': 30,
  'provider-fallback': 5,
  'compact-failure': 3,
};
const RECOVERY_CAP_ENV_KEYS: Record<RecoveryKind, string> = {
  'provider-400-retry': 'CODER_RECOVERY_400_MAX',
  'provider-401-refresh': 'CODER_RECOVERY_401_MAX',
  'provider-transient-retry': 'CODER_RECOVERY_TRANSIENT_MAX',
  'provider-fallback': 'CODER_RECOVERY_FALLBACK_MAX',
  'compact-failure': 'CODER_RECOVERY_COMPACT_MAX',
};
function recoveryCap(kind: RecoveryKind): number {
  const envVal = process.env[RECOVERY_CAP_ENV_KEYS[kind]];
  if (envVal != null && envVal !== '') {
    const n = Number(envVal);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return RECOVERY_CAP_DEFAULTS[kind];
}

/**
 * Tenacity-style exp+jitter backoff (PR-2, R5 from
 * docs/agent-research/COMPARISON.md). Mirrors kimi-cli's
 * `wait_exponential_jitter(initial=0.3, max=5, jitter=0.5)`. Returns a
 * delay in milliseconds for the given 1-based attempt number.
 */
/**
 * PR-3 (R4): how many user-message turns to keep raw past the compaction
 * boundary. Mirrors kimi-cli's `max_preserved_messages=2`. Lazy-resolved
 * so tests can override post-import.
 */
function preserveLastNTurns(): number {
  const v = process.env.CODER_COMPACT_PRESERVE_LAST_N_TURNS;
  if (v != null && v !== '') {
    const n = Number(v);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return 2;
}

/** Read lazily so tests can override after import. */
function transientRetryMaxPerTurn(): number {
  const v = process.env.CODER_TRANSIENT_RETRY_MAX_PER_TURN;
  if (v != null && v !== '') {
    const n = Number(v);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return 3;
}
function transientRetryInitialMs(): number {
  const v = process.env.CODER_TRANSIENT_RETRY_INITIAL_MS;
  if (v != null && v !== '') {
    const n = Number(v);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return 300;
}
function transientRetryMaxMs(): number {
  const v = process.env.CODER_TRANSIENT_RETRY_MAX_MS;
  if (v != null && v !== '') {
    const n = Number(v);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return 5000;
}
function transientRetryJitter(): number {
  const v = process.env.CODER_TRANSIENT_RETRY_JITTER;
  if (v != null && v !== '') {
    const n = Number(v);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return 0.5;
}

function nonRetryableProviderErrorReason(error: Error, raw: unknown): string | null {
  const candidates = [
    error.message,
    (raw as { error?: { message?: unknown } })?.error?.message,
    (raw as { error?: { type?: unknown } })?.error?.type,
    (raw as { code?: unknown })?.code,
  ];
  const text = candidates
    .filter((value): value is string => typeof value === 'string')
    .join('\n')
    .toLowerCase();

  if (
    text.includes('out of extra usage') ||
    text.includes('claude.ai/settings/usage') ||
    text.includes('out_of_credits')
  ) {
    return 'provider quota/extra usage exhausted';
  }
  return null;
}

export function backoffDelayMs(
  attempt: number,
  opts: { initialMs?: number; maxMs?: number; jitter?: number; rng?: () => number } = {},
): number {
  const initial = opts.initialMs ?? transientRetryInitialMs();
  const max = opts.maxMs ?? transientRetryMaxMs();
  const jitter = opts.jitter ?? transientRetryJitter();
  const rng = opts.rng ?? Math.random;
  const a = Math.max(1, Math.floor(attempt));
  // Exp curve (1 → initial, 2 → 2*initial, 3 → 4*initial, ...) capped at max.
  const baseExp = Math.min(max, initial * Math.pow(2, a - 1));
  // Symmetric jitter in [-j*base, +j*base].
  const jitterAmount = baseExp * jitter * (rng() * 2 - 1);
  return Math.max(0, Math.round(baseExp + jitterAmount));
}

/**
 * Cycle-aware dominance guard (Fix G). Catches the pattern session 609
 * exhibited: 50+ consecutive turns dominated by `mcp__read_file` with
 * ZERO assistant text emitted between them. Without text the agent has
 * no reasoning anchor — every "round" rediscovers the same content.
 * When the dominance check trips we abort with a clear error rather
 * than refuse a single call, because the agent has already shown it
 * can't break out by itself.
 *
 * Default: 15 turns / 80% dominance / 0 text turns.
 */
const DOMINANCE_WINDOW = Number(process.env.CODER_DOMINANCE_WINDOW ?? 15);
const DOMINANCE_RATIO = Number(process.env.CODER_DOMINANCE_RATIO ?? 0.8);
/**
 * Auto-continue: when the runner exhausts maxTurns, instead of dying it
 * compacts the history (summarizer → deterministic fallback) and resets the
 * turn counter. This mirrors Claude Code's behaviour where the agent never
 * stops due to turn limits alone — only due to lack of work or explicit abort.
 * Set to 0 to disable (legacy hard-stop at maxTurns).
 */
const MAX_AUTO_CONTINUES = Number(process.env.CODER_MAX_AUTO_CONTINUES ?? 3);

/** How often (in turns) to re-inject the deliverable reminder for subordinate agents. */
const SUBORDINATE_REMINDER_INTERVAL = Number(process.env.CODER_SUBORDINATE_REMINDER_INTERVAL ?? 8);
const SUBORDINATE_REMINDER_MSG =
  '[System reminder] Before you stop or consider the task done, your LAST action MUST be ' +
  '`post_to_board` with kind="deliverable" summarizing your work. Never finish silently — ' +
  'the master is waiting for your report and cannot see your work any other way.';

/**
 * Deterministic signature of a turn's tool calls. Two turns with the same
 * signature asked the model to do literally the same thing — if that repeats
 * past the threshold, we're looping. Keys in each input object are sorted so
 * cosmetic reordering doesn't mask the repetition.
 */
export function toolCallsSignature(
  blocks: Array<{ name: string; input: Record<string, unknown> }>,
): string {
  if (blocks.length === 0) return '';
  const stable = (v: unknown): unknown => {
    if (v === null || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map(stable);
    const keys = Object.keys(v as Record<string, unknown>).sort();
    const out: Record<string, unknown> = {};
    for (const k of keys) out[k] = stable((v as Record<string, unknown>)[k]);
    return out;
  };
  const items = blocks
    .map((b) => `${b.name}:${JSON.stringify(stable(b.input))}`)
    .sort();
  return items.join('|');
}

/**
 * Loose signature: just the sorted tool names. Ignores argument differences
 * so the fuzzy doom-loop guard can catch near-repeats where the model keeps
 * calling the same tools with tweaked arguments without making progress.
 */
export function toolNamesSignature(blocks: Array<{ name: string }>): string {
  if (blocks.length === 0) return '';
  return blocks.map((b) => b.name).sort().join('|');
}

/**
 * Hide `create_goal` from the tool surface when a goal is already
 * in_progress. Sessions 656/658 showed the model — even after explicit
 * "ignore the GOAL" user instructions — emitting `create_goal` instead
 * of doing the actual work, looping for many turns until the session
 * went idle. Caps and nudges paradoxically reinforced the pattern by
 * keeping the tool name in the model's context. Removing the option
 * from the surface (the model literally never sees the tool) makes
 * the loop impossible by construction.
 *
 * `get_goal` and `update_goal` stay visible always — the agent must
 * be able to re-read the objective and mark it complete. Once
 * update_goal flips the status to 'complete', the next turn's
 * buildTools() sees no in-progress goal and re-exposes create_goal,
 * so legitimate pivot flows still work.
 *
 * Pure function — pulled out of buildTools() so we can unit-test the
 * filter directly without spinning up a full runner.
 */
export function filterGoalToolsByState<T extends { name: string }>(
  tools: T[],
  goalState: { status: 'in_progress' | 'complete' } | null | undefined,
): T[] {
  if (goalState && goalState.status === 'in_progress') {
    return tools.filter((t) => t.name !== 'create_goal');
  }
  return tools;
}

export function approxChars(messages: AgentMessage[]): number {
  let total = 0;
  for (const m of messages) {
    for (const b of m.content) {
      total += 32; // per-block overhead estimate
      if (typeof (b as { content?: unknown }).content === 'string') {
        total += ((b as { content: string }).content).length;
      }
      if (typeof (b as { text?: unknown }).text === 'string') {
        total += ((b as { text: string }).text).length;
      }
      if (typeof (b as { input?: unknown }).input === 'object' && (b as { input?: unknown }).input) {
        try { total += JSON.stringify((b as { input: unknown }).input).length; } catch { /* ignore */ }
      }
    }
  }
  return total;
}

/**
 * Build a tool_result block, applying push-time truncation if the content
 * exceeds PUSH_TIME_CAP. The truncation marker is deterministic — it depends
 * only on the original size, not on the current turn or surrounding context —
 * so once a block is created it never changes.
 */
export function buildToolResultBlock(
  toolUseId: string,
  content: string,
  isError?: boolean,
  cap: number = PUSH_TIME_CAP,
  outputId?: string,
): ToolResultBlock {
  if (content.length <= cap) {
    return { type: 'tool_result', tool_use_id: toolUseId, content, is_error: isError };
  }
  const head = content.slice(0, cap);
  // Deterministic marker. Two identical outputs → identical marker (same
  // original_size, same outputId because the store hashes content). Once a
  // block is created, its content never changes across turns — preserves
  // prefix-cache stability.
  const idSuffix = outputId
    ? `; output_id=${outputId}, call get_tool_output("${outputId}") to retrieve the full content (supports offset/limit for pagination)`
    : '';
  return {
    type: 'tool_result',
    tool_use_id: toolUseId,
    content:
      head +
      `\n\n[truncated: original_size=${content.length} chars; ${content.length - cap} chars elided — call the tool again with narrower params if needed, OR explicitly use 'spawn_agents' to delegate this exploration without bloating your main context window${idSuffix}]`,
    is_error: isError,
    truncated: true,
    originalSize: content.length,
  };
}

/** Cap value used by subagents (tighter than parent default). */
export const SUBAGENT_TOOL_RESULT_CAP = SUBAGENT_PUSH_TIME_CAP;

/**
 * Normalize a message coming from the DB on session resume. Older sessions
 * may contain un-truncated tool_result blocks that would otherwise pollute
 * the cache prefix. Re-applying buildToolResultBlock() yields the same
 * deterministic shape used by fresh sessions.
 *
 * @param cap When omitted, falls back to the production `PUSH_TIME_CAP`.
 *   Sessions with `unrestricted_tool_output` enabled pass their
 *   `effectivePushTimeCap` so blocks that legitimately fit under the
 *   raised ceiling are NOT re-truncated to 24k on resume.
 */
export function normalizeMessageForCache(m: AgentMessage, cap: number = PUSH_TIME_CAP): AgentMessage {
  if (m.role !== 'tool' && m.role !== 'user') return m;
  let mutated = false;
  const content = m.content.map((b): ContentBlock => {
    if (b.type !== 'tool_result') return b;
    if (b.truncated) return b; // already deterministic, leave alone
    if (b.content.length <= cap) return b;
    mutated = true;
    return buildToolResultBlock(b.tool_use_id, b.content, b.is_error, cap);
  });
  return mutated ? { ...m, content } : m;
}

/**
 * Per-turn history transformer applied right before the request hits the
 * provider. Two-layer strategy:
 *
 *   1. Push-time truncation (already done at block creation) keeps the
 *      PER-BLOCK size bounded, which is enough for 99% of sessions.
 *
 *   2. Auto-compaction (delegated to core/compaction.ts) kicks in ONLY when
 *      the accumulated total still exceeds PRUNE_MINIMUM, at which point
 *      older tool_result contents get swapped for deterministic markers
 *      until the protected tail fits under PRUNE_PROTECT.
 *
 * The compaction is a pure transformation — the persistent history on disk
 * stays intact — and uses a deterministic cutoff so repeated calls on the
 * same prefix produce byte-identical output. That keeps prompt-prefix caches
 * hot across turns even after compaction has fired.
 */
export function compactHistoryForLLM(
  messages: AgentMessage[],
  limits?: { minimum: number; protect: number },
): AgentMessage[] {
  // Camada 5 — rolling reduction runs FIRST and is cheap (linear scan,
  // pure function, deterministic). It retires stale repeated reads/searches
  // before the size-based compaction even sees them, so sessions grow
  // sublinearly. Disabled via CODER_ROLLING_REDUCER=0 for diagnostics.
  let working = messages;
  if (process.env.CODER_ROLLING_REDUCER !== '0') {
    const rolled = applyRollingReduction(messages);
    if (rolled.reduced > 0) {
      console.log(
        `[coder] rolling reducer retired ${rolled.reduced} stale tool_result(s) ` +
          `(~${rolled.freedChars} chars freed)`,
      );
      working = rolled.messages;
    }
  }
  const result = compactMessages(working, limits);
  if (result.applied) {
    console.log(
      `[coder] compaction pruned ${result.prunedBlocks} tool_result blocks ` +
      `(~${result.prunedChars} chars) — protect budget ${limits?.protect ?? PRUNE_PROTECT}`,
    );
  }
  const total = approxChars(result.messages);
  if (total > TURN_BUDGET_CHARS) {
    console.warn(
      `[coder] turn payload ${total} chars exceeds budget ${TURN_BUDGET_CHARS}. ` +
      `Lower CODER_PUSH_TIME_CAP or increase CODER_TURN_BUDGET_CHARS.`,
    );
  }

  // Safety net: remove orphaned tool_results whose tool_use was dropped
  // (e.g. by a prior summarizer splice). Without this, the provider rejects
  // the request with "400 No tool call found for function call output".
  const knownToolUseIds = new Set<string>();
  for (const m of result.messages) {
    if (m.role !== 'assistant') continue;
    for (const b of m.content) {
      if (b.type === 'tool_use') knownToolUseIds.add(b.id);
    }
  }
  let orphanCount = 0;
  const sanitized = result.messages.map((m): AgentMessage | null => {
    if (m.role !== 'tool') return m;
    const filtered = m.content.filter((b) => {
      if (b.type !== 'tool_result') return true;
      const tid = (b as { tool_use_id?: string }).tool_use_id;
      if (tid && !knownToolUseIds.has(tid)) {
        orphanCount++;
        return false;
      }
      return true;
    });
    if (filtered.length === 0) return null;
    if (filtered.length === m.content.length) return m;
    return { ...m, content: filtered };
  }).filter((m): m is AgentMessage => m !== null);

  if (orphanCount > 0) {
    console.warn(
      `[coder] sanitized ${orphanCount} orphaned tool_result block(s) ` +
      `whose tool_use was removed by summarization`,
    );
  }

  // Safety net 2: inject synthetic tool_result for orphaned tool_use blocks
  // (tool_use exists in assistant message but no matching tool_result in any
  // tool message). This happens when the runner crashes/aborts between
  // persisting the assistant message and persisting the tool result message.
  // Without this, the provider rejects with
  // "400 No tool output found for function call".
  const knownToolResultIds = new Set<string>();
  for (const m of sanitized) {
    if (m.role !== 'tool') continue;
    for (const b of m.content) {
      if (b.type === 'tool_result') {
        const tid = (b as { tool_use_id?: string }).tool_use_id;
        if (tid) knownToolResultIds.add(tid);
      }
    }
  }

  let syntheticCount = 0;
  const patched: AgentMessage[] = [];
  for (let i = 0; i < sanitized.length; i++) {
    const m = sanitized[i];
    patched.push(m);
    if (m.role !== 'assistant') continue;

    const orphanedToolUses: Array<{ id: string; name: string }> = [];
    for (const b of m.content) {
      if (b.type === 'tool_use' && !knownToolResultIds.has(b.id)) {
        orphanedToolUses.push({ id: b.id, name: b.name });
      }
    }
    if (orphanedToolUses.length === 0) continue;

    // Check if the very next message is already a tool message that covers
    // some of these IDs (partial coverage). Only inject for truly missing ones.
    const next = sanitized[i + 1];
    if (next?.role === 'tool') {
      const coveredIds = new Set<string>();
      for (const b of next.content) {
        if (b.type === 'tool_result') {
          const tid = (b as { tool_use_id?: string }).tool_use_id;
          if (tid) coveredIds.add(tid);
        }
      }
      const stillOrphaned = orphanedToolUses.filter((tu) => !coveredIds.has(tu.id));
      if (stillOrphaned.length === 0) continue;

      // Merge synthetic results into the existing tool message
      const syntheticResults = stillOrphaned.map((tu) => ({
        type: 'tool_result' as const,
        tool_use_id: tu.id,
        content: `[Session interrupted — tool "${tu.name}" was running when the session ended. Result was not captured.]`,
        is_error: true,
      }));
      // Replace next message with merged version
      sanitized[i + 1] = { ...next, content: [...next.content, ...syntheticResults] };
      syntheticCount += stillOrphaned.length;
    } else {
      // No tool message follows — inject a new one
      const syntheticResults = orphanedToolUses.map((tu) => ({
        type: 'tool_result' as const,
        tool_use_id: tu.id,
        content: `[Session interrupted — tool "${tu.name}" was running when the session ended. Result was not captured.]`,
        is_error: true,
      }));
      patched.push({ role: 'tool' as const, content: syntheticResults });
      // Skip the next message if it was already pushed (it wasn't a tool msg)
      syntheticCount += orphanedToolUses.length;
    }
  }

  const resultArray = syntheticCount > 0 ? patched : sanitized;

  // Merge consecutive same-role messages to avoid 400 "The messages parameter
  // is illegal" from providers that strictly require alternating turns.
  // User merges: classic Anthropic requirement.
  // Assistant merges: happens after summarizer splice when the synthetic
  // assistant is followed by an original assistant (GLM error 1214).
  const merged: AgentMessage[] = [];
  for (const m of resultArray) {
    const last = merged[merged.length - 1];
    if (last && last.role === 'user' && m.role === 'user') {
      last.content = [...last.content, ...m.content];
    } else if (last && last.role === 'assistant' && m.role === 'assistant') {
      last.content = [...last.content, ...m.content];
    } else {
      merged.push({ ...m, content: [...m.content] });
    }
  }

  if (syntheticCount > 0) {
    console.warn(
      `[coder] injected ${syntheticCount} synthetic tool_result(s) for orphaned ` +
      `tool_use blocks (session was interrupted mid-tool-execution)`,
    );
  }

  return merged;
}

/**
 * Events emitted by the runner. CLI and SSE handler both consume these.
 */
export interface RunnerEvents {
  text_delta: (text: string) => void;
  thinking_delta: (text: string) => void;
  tool_call_start: (id: string, name: string, input: Record<string, unknown>) => void;
  tool_call_result: (id: string, name: string, result: { content: string; isError?: boolean; subUsage?: ChatUsage }, durationMs: number) => void;
  message_complete: (message: AgentMessage, usage: ChatUsage | null) => void;
  turn_start: (turn: number) => void;
  /**
   * Emitted exactly once when the run terminates. `reason` is the most
   * specific applicable value from {@link StopReason}. `error` carries the
   * underlying Error for failure modes (`error`, `recovery_capped`,
   * `doom_loop`); undefined for clean exits. `transition` records the
   * recovery path that led here (when applicable) — pairs with the
   * `recoveryAttempts` map for billing/debug attribution.
   *
   * Existing consumers that only read the first 1–2 args remain
   * source-compatible; the new args default to undefined.
   */
  done: (reason: StopReason, error?: Error, transition?: TransitionKind | null) => void;
  /** Emitted when the agent calls submit_plan; payload waits for /plan-response. */
  plan_posted: (block: PlanBlock) => void;
  /** Emitted when the agent calls ask_user; payload waits for /answer. */
  question_posted: (block: QuestionBlock) => void;
  /** Emitted when provider/model is swapped mid-session. */
  provider_swapped: (provider: string, model: string) => void;
  /** Emitted by submit_tasks; payload is the proposed task list waiting for /tasks-response. */
  tasks_posted: (payload: {
    tool_use_id: string;
    summary: string;
    tasks: import('../sessions/types.js').CoderTask[];
    version: number;
  }) => void;
  /** Emitted when execute_task starts processing a single task. */
  task_started: (payload: { task_id: string; mode: 'inline' | 'subagent'; started_at: string }) => void;
  /** Emitted when a task finishes (done/failed/skipped/interrupted). */
  task_finished: (payload: {
    task_id: string;
    status: import('../sessions/types.js').TaskStatus;
    result: import('../sessions/types.js').TaskResult | null;
    finished_at: string;
  }) => void;
  /** Emitted by `update_task` when the agent surgically patches one task
   *  (status/files/title/description) without resubmitting the whole list.
   *  Lets the dashboard sidebar refetch state-summary on the spot instead of
   *  waiting until the turn ends. */
  task_updated: (payload: {
    task_id: string;
    patch: Partial<import('../sessions/types.js').CoderTask>;
  }) => void;
  /** Emitted when `todo_write` replaces the session's lightweight checklist. */
  todos_updated: (payload: {
    todos: import('../tools/todo.js').TodoItem[];
  }) => void;
  /** Agent Loop v2: emitted when the stop-guard intercepts a 'completed' turn
   *  and pushes back a single recap because todos are still unfinished. */
  stop_nudged: (payload: { turn: number; recap: string }) => void;
  /** PR-2 (R1): emitted when a per-recovery-path circuit breaker exceeds
   *  its cap and the loop bails with reason='error'. */
  recovery_aborted: (payload: {
    kind: 'provider-400-retry' | 'provider-401-refresh' | 'provider-transient-retry' | 'provider-fallback' | 'compact-failure';
    attempts: number;
    cap: number;
    contextHint: string | null;
  }) => void;
  /** Emitted when `enter_worktree` swaps the session cwd for a worktree. */
  worktree_entered: (payload: { path: string; originalCwd: string }) => void;
  /** Emitted when `exit_worktree` restores the session cwd to the project root. */
  worktree_exited: (payload: { path: string }) => void;
  /** Emitted when spawn_agents starts a parallel agent group. */
  agents_group_start: (payload: {
    groupId: string;
    provider?: string;
    model?: string;
    agents: Array<{ index: number; label: string; provider?: string; model?: string }>;
  }) => void;
  /** Emitted for per-agent progress within a parallel group. */
  agent_progress: (payload: {
    groupId: string;
    agentIndex: number;
    label: string;
    event: 'spawned' | 'tool_call' | 'completed' | 'error';
    provider?: string;
    model?: string;
    toolCallCount?: number;
    usage?: ChatUsage;
    summary?: string;
    error?: string;
  }) => void;
  /** Emitted when all agents in a parallel group have finished. */
  agents_group_end: (payload: {
    groupId: string;
    totalUsage: ChatUsage;
    agentCount: number;
    successCount: number;
  }) => void;
  /** Emitted when the runner auto-continues after hitting maxTurns. */
  auto_continue: (count: number, max: number) => void;
  /** Emitted per-turn with context size metrics for the dashboard. */
  context_status: (payload: {
    history_chars: number;
    turn: number;
    max_turns: number;
    auto_continue_count: number;
    auto_continue_max: number;
    last_turn_input_tokens: number;
    context_window: number | null;
  }) => void;
  /** Emitted when a fallback provider is activated due to persistent errors. */
  fallback_activated: (payload: {
    from: { provider: string; model: string };
    to: { provider: string; model: string };
    error: string;
  }) => void;
  /** Emitted when the runner compacts history during auto-continue so the
   *  dashboard can show the user which turns were summarized away. */
  history_compacted: (payload: {
    strategy: 'summarizer' | 'deterministic' | 'none';
    pruned_messages: number;
    pruned_chars: number;
    total_chars_before: number;
    total_chars_after: number;
    auto_continue: number;
  }) => void;
  /**
   * Emitted exactly once at the start of `run()`. Carries a fresh runId so
   * downstream observers can correlate the rest of the lifecycle events
   * even when several `runCoder()` calls share the same persistent session.
   */
  run_started: (payload: {
    runId: string;
    provider: string;
    model: string;
    profile: string | null;
    planMode: boolean;
    maxTurns: number;
  }) => void;
  /**
   * Emitted right before each `provider.chat()` call. Useful for measuring
   * cache-hit rate against retries: a turn that re-enters this event after
   * a 400/401 retry has the same `turn` index as the previous emission.
   */
  provider_call: (payload: {
    runId: string;
    turn: number;
    provider: string;
    model: string;
    toolCount: number;
    historyChars: number;
  }) => void;
  /**
   * Emitted alongside `provider_call` with the temperature the runner picked
   * for this turn. `source` records WHICH layer of the precedence chain won
   * (session/role/agent/default), or `'skipped'` when the model rejected
   * sampling. Dashboard renders this as a per-turn "T" indicator.
   */
  temperature_resolved: (payload: {
    runId: string;
    turn: number;
    provider: string;
    model: string;
    agent: import('../agents/index.js').AgentId | null;
    temperature: number | undefined;
    source: 'session' | 'role' | 'agent' | 'default' | 'skipped';
    reason?: 'reasoning_model' | 'thinking_enabled';
  }) => void;
  /**
   * Emitted once per turn, after the assistant message lands and before
   * tool execution starts. Empty `names` means "no tool calls — turn ends
   * with assistant text". Lets the dashboard preview the upcoming batch.
   */
  tool_batch: (payload: {
    runId: string;
    turn: number;
    count: number;
    names: string[];
  }) => void;
  /**
   * Emitted whenever a tool invocation is refused for a safety reason
   * (plan mode, task scope, shell allowlist, sandbox required, admin
   * override required). Carries enough detail to surface a banner to
   * the user without parsing the result text. The reason union mirrors
   * `PolicyReason` from `core/policy.ts` plus the legacy `shell_allowlist`
   * value (kept for shell.ts which gates internally rather than via
   * the policy module).
   */
  blocked: (payload: {
    runId: string;
    turn: number;
    tool: string;
    reason:
    | 'plan_mode'
    | 'task_scope'
    | 'shell_allowlist'
    | 'sandbox_required'
    | 'admin_required';
    detail?: string;
  }) => void;
}

/**
 * Turn-based agent loop:
 *   1. Stream provider response, collecting text + tool_use blocks
 *   2. Persist the assistant message
 *   3. For each tool_use, execute via registry, append tool_result
 *   4. Loop until the assistant returns no tool calls (or max_turns)
 */
export class CoderRunner extends EventEmitter {
  readonly messages: AgentMessage[];
  private opts: RunnerOptions;
  private readonly maxTurns: number;
  private aborted = false;
  /**
   * Live turn counter — mirrored from the loop-local `turn` variable so
   * external observers (e.g. SnapshotRecorder via ctx.runner) can stamp
   * audit rows with the correct turn number while a turn is in flight.
   * 0 before the first turn starts.
   */
  public turn = 0;
  private pendingResolve: ((value: string) => void) | null = null;
  private pendingUserMessages: string[] = [];
  private planApproved = false;
  /**
   * Plan-mode enforcement: when the model finishes a turn (no tool calls)
   * without ever calling submit_plan, the runner injects ONE explicit nudge
   * and re-runs the loop. If the second turn also exits without a plan, the
   * run fails with reason='plan_required'. Reset on each runCoder() call
   * because a fresh runner is instantiated per user message.
   */
  /**
   * Set to true once the user approves a submit_tasks list. Counts as a
   * satisfied plan-mode nudge (no separate nudge for tasks). Mutating tools
   * still need an active currentTaskScope to actually run, though.
   */
  private tasksApproved = false;
  /**
   * The task currently being executed inline. While set, mutating tools are
   * permitted but only for paths inside `files`. Cleared by task_complete or
   * by error. null = no inline task active (subagent execution doesn't set
   * this — subagents have their own runner).
   */
  private currentTaskScope: { id: string; files: string[] } | null = null;
  /**
   * Ring of the most recent turn signatures (oldest → newest). When its
   * length reaches DOOM_LOOP_THRESHOLD and every entry is identical, the
   * next turn is refused to break the loop.
   */
  private recentTurnSignatures: string[] = [];
  /** Ring of loose (tool-name-only) signatures for the fuzzy guard. */
  private recentTurnNamesSignatures: string[] = [];

  /**
   * One-shot flag for the `create_goal hidden` log. Flipped true the first
   * turn buildTools() removes the tool from the surface; reset to false
   * any turn the goal isn't in_progress. Keeps the dashboard log readable
   * (one line per transition) instead of spamming it every turn while a
   * goal is active.
   */
  private goalToolHiddenLogged = false;

  /**
   * Per-arg call-frequency tracker (Fix F). Map key is
   * `<toolName>#<sha1(JSON.stringify(args))>`, value is the list of
   * turn-numbers at which that exact call was issued. Old entries fall
   * out of the window automatically when we check.
   */
  private toolCallFreq: Map<string, number[]> = new Map();
  /**
   * Set of (toolName|argsJson) hashes that asked for user confirmation and
   * are awaiting a retry. Populated when an `admin`-mode call hits the
   * irreversible-tool gate; consumed on the LLM's next attempt with the
   * same args (interpreted as "user said yes, retrying"). Cleared on
   * consumption so a third attempt would re-prompt. See dispatch path.
   */
  private pendingConfirms: Set<string> = new Set();

  /**
   * Agent Loop v2 result-content dedup. Maps tool name → recent
   * { contentHash, turn } entries within a rolling window. Catches the
   * "snap-to-symbol" loop where the agent shifts `around_line` by a few
   * each call but the resolver returns the SAME body. The arg-hash dup-call
   * cap (Fix F) misses this because args differ; the rolling-reduction
   * dedup-key misses it because it uses raw args, not the resolved slice.
   * Hashing the raw `result.content` catches it post-resolution.
   */
  private recentResultHashes: Map<string, Array<{ hash: string; turn: number }>> = new Map();

  /**
   * PR-5 (Row 32) — pre-read enforcement. Tracks recent read-family tool
   * calls keyed by (toolName, path, slice-fields) so the runner can REFUSE
   * a duplicate before dispatching it. Distinct from `toolCallFreq` (which
   * uses raw arg JSON and a higher threshold) and `recentResultHashes`
   * (which catches duplicates AFTER the call returns identical content).
   *
   * Each entry carries the `useId` of the corresponding tool_use block so
   * the smarter guard can check whether the matching tool_result is still
   * visible in `this.messages` (or has been elided by postCompactCleanup —
   * in which case re-reading is legitimate, not a loop). `mtimeMs` and
   * `contentHash` are populated AFTER dispatch and used to detect staleness
   * and to short-circuit the diff path when the file has not changed.
   */
  private recentReadKeys: Map<string, Array<{
    turn: number;
    useId: string;
    mtimeMs?: number;
    contentHash?: string;
  }>> = new Map();

  /**
   * Per-path mutation tracker. Updated after a successful dispatch of any
   * `isMutatingFsTool` (write_file, edit_file, multi_edit, create_file,
   * apply_patch). The pre-read guard reads it to decide whether a re-read
   * is actually fetching new state (file changed since prior read) — in
   * which case the call is allowed and the result is post-processed into
   * a unified diff against the prior content.
   */
  private recentWrites: Map<string, number> = new Map();

  /**
   * Set by the pre-read guard when it decides to ALLOW a re-read after a
   * mutation: keyed by the new tool_use id (block.id), points to the prior
   * read's useId/turn so the post-dispatch hook can replace the new
   * tool_result content with a unified diff. Cleared per turn boundary
   * (entries naturally expire as the keys go out of scope).
   */
  private pendingDiffRereads: Map<string, { priorUseId: string; priorTurn: number; path: string }> = new Map();

  /**
   * Sliding window of (toolName, hadAssistantText) per turn — used by
   * the dominance guard (Fix G) to detect "agent stuck reading without
   * reasoning" patterns. Capped to DOMINANCE_WINDOW entries; oldest
   * shifted out at the edge.
   */
  private recentTurnDominance: Array<{ name: string; hadText: boolean }> = [];

  /**
   * Lightweight todo list maintained by the `todo_write` tool. Distinct from
   * the heavyweight `submit_tasks` flow — todos never pause the run; they
   * just broadcast a `todos_updated` event so the dashboard can render a
   * live sidebar. Persisted in `coder_sessions.todos_json` across restarts.
   */
  public currentTodos: import('../tools/todo.js').TodoItem[] = [];

  /**
   * Worktree scope tracking. When `enter_worktree` is called, the runner
   * remembers the original project root in `originalCwd` and swaps
   * `toolContext.cwd` for the worktree path. `exit_worktree` reverses both.
   * Persisted in `coder_sessions.worktree_path` so a session resume after a
   * server restart continues in the same worktree.
   */
  public originalCwd: string | null = null;
  public worktreePath: string | null = null;

  /** Set to true after the LLM summarizer has run once in this session.
   *  Prevents re-summarizing every turn — one pass replaces the old span,
   *  and subsequent growth is handled by deterministic compaction. */
  private summarizedOnce = false;

  /** Agent Loop v2 stop-guard: ensures we nudge at most once per session
   *  when the model tries to stop with `pending`/`in_progress` todos. */
  private agentLoopV2NudgeUsed = false;

  /**
   * Per-recovery-path attempt counter (PR-2, R1). Each recovery kind has
   * its own session-lifetime cap defined in RECOVERY_CAPS. When a kind
   * exceeds its cap we abort with a structured error rather than letting
   * the loop spin and burn tokens on a broken server.
   */
  private recoveryAttempts: Map<RecoveryKind, number> = new Map();

  /**
   * PR-4 (Row 3): record of the most recent recovery transition the runner
   * took. Set whenever a recovery path is entered (compact-retry,
   * transient-retry, fallback-swap, doom-loop, etc.). Read at exit time so
   * the final `done` event and `RunResult` can attribute the stop to the
   * recovery path that led there. null = clean run with no recoveries.
   */
  private lastTransition: TransitionKind | null = null;
  private setTransition(kind: TransitionKind): void {
    this.lastTransition = kind;
  }

  /**
   * Compose the final {@link RunResult} and emit the matching `done` event
   * in one shot. All terminal sites in `run()` go through this so the
   * three-tuple (reason, error, transition) is consistent. Idempotent: if
   * called twice in the same run() invocation, only the first take effects.
   */
  private finishWith(
    totalUsage: ChatUsage,
    reason: StopReason,
    error?: Error,
    transition?: TransitionKind | null,
  ): RunResult {
    const t = transition !== undefined ? transition : this.lastTransition;
    this.emit('done', reason, error, t);
    return { totalUsage, reason, transition: t };
  }

  /**
   * Try to record a recovery attempt of the given kind. Returns true if
   * the attempt is within budget (proceed); false if the cap is exceeded
   * (abort). Emits `recovery_aborted` on cap exceeded for telemetry. Cap
   * source is `RECOVERY_CAPS[kind]`; override via env (CODER_RECOVERY_*).
   */
  private tryRecord(kind: RecoveryKind, contextHint?: string): boolean {
    const next = (this.recoveryAttempts.get(kind) ?? 0) + 1;
    this.recoveryAttempts.set(kind, next);
    const cap = recoveryCap(kind);
    if (next > cap) {
      console.warn(
        `[coder] recovery cap exceeded for kind=${kind}: ${next}/${cap}` +
          (contextHint ? ` (${contextHint})` : ''),
      );
      this.emit('recovery_aborted', {
        kind,
        attempts: next,
        cap,
        contextHint: contextHint ?? null,
      });
      return false;
    }
    return true;
  }

  /**
   * Phase tracking (Camada 2 — Phase Profiles) was REMOVED in favor of
   * single-model legacy behavior. The mid-turn provider swaps were too
   * disruptive to cache stability and made model behavior unpredictable.
   * Field preserved as `null` so existing telemetry stamping in index.ts
   * keeps compiling without conditional churn.
   */
  public currentPhase: string | null = null;

  /**
   * Id of the most recent `coder_turn_telemetry` row inserted by the runner.
   * Exposed (public) so the persistence layer in index.ts can stamp the
   * tool_calls of this turn with `turn_telemetry_id`, giving dashboards a
   * clean JOIN between per-call cost and per-turn token usage. Null when
   * sessionStore is absent (subagents/tests) or the insert failed.
   */
  public lastTurnTelemetryId: number | null = null;

  /**
   * Currently active tool tiers. When null, no tier filtering is applied
   * (all registered tools visible to the provider — legacy behaviour used
   * by subagents and tests). When a Set, the runner filters registry.list()
   * each turn so only tools whose tier is in the set reach the LLM.
   *
   * Grows monotonically via `promoteTier()` — tiers never shrink mid-session
   * so the prefix cache can re-stabilize after a single promotion event.
   */
  public activeTiers: Set<ToolTier> | null = null;

  /**
   * Last `response.id` returned by the Responses API (ChatGPT/Codex with
   * `store: true`). Updated by `onResponseId` after every turn. Sent as
   * `previous_response_id` on the next turn so the backend reconstructs the
   * prefix from its stored copy (40-80% better cache hit than restating).
   */
  public previousResponseId: string | null = null;
  /** Companion to `previousResponseId` — number of messages on server side. */
  public previousResponseMessageCount: number | null = null;

  /**
   * Stable identifier for the current run() invocation. Generated fresh in
   * the constructor (UUID v4) so each runCoder() call has a unique handle
   * even when several share the same persistent session id. Carried in the
   * payloads of run_started / provider_call / tool_batch / blocked so
   * downstream observers can correlate lifecycle events.
   */
  public readonly runId: string = randomUUID();
  /** PR-6: exposed so subagent factories can propagate the v2 flag onto
   *  spawned subagents (pre-read cap, result-dup, exp+jitter, framing). */
  public get agentLoopV2(): boolean { return this.opts.agentLoopV2 === true; }

  /** Public mirrors of opts.sessionId / opts.isSubagent so subagent factories can inherit them. */
  public readonly sessionId: number | undefined;
  public readonly isSubagent: boolean;
  /** Optional SessionStore for input-log mirroring; see RunnerOptions. */
  public readonly sessionStore: import('../sessions/store.js').SessionStore | undefined;
  /**
   * Resolved per-block tool-result cap for this run. Computed once in the
   * constructor from `opts.unrestrictedToolOutput`, `opts.pushTimeCap`, and
   * `opts.isSubagent`. All callsites that previously read
   * `this.effectivePushTimeCap` should use this instead so the
   * unrestricted ceiling stays consistent across `buildToolResultBlock`
   * arguments and the side-file `toolOutputStore` gate.
   */
  public readonly effectivePushTimeCap: number;

  /**
   * Best-effort mirror of a runtime system-reminder injection into
   * `coder_session_inputs` so the dashboard's Input tab shows what was
   * pushed under the hood. No-op when sessionStore/sessionId are absent
   * (subagents, tests). Dedup is handled by SessionStore.recordSessionInput.
   */
  private logSystemReminder(tag: string, content: string): void {
    if (!this.sessionStore || this.sessionId == null) return;
    try {
      this.sessionStore.recordSessionInput({
        session_id: this.sessionId,
        kind: 'system_reminder',
        source_label: `reminder:${tag}`,
        content,
      });
    } catch {
      // best-effort
    }
  }

  /**
   * Per-turn telemetry hook. Captures token + tool usage at the end of each
   * turn so dashboards can answer "where are tokens being spent?" with data.
   *
   * Intentionally best-effort: a missing sessionStore (subagents, tests) is a
   * no-op, and any DB error is swallowed inside SessionStore.recordTurnTelemetry.
   */
  private persistTurnTelemetry(input: {
    turn: number;
    lastUsage: ChatUsage | null;
    toolUseBlocks: ReadonlyArray<ToolUseBlock>;
    toolResultBlocks: ReadonlyArray<ContentBlock>;
    historyChars: number;
    compactionTriggered: boolean;
    summarizerRan: boolean;
    /** Size of the system prompt actually shipped to the provider (chars). */
    systemPromptChars?: number;
    /** Size of the tools array actually shipped to the provider (JSON-stringified chars). */
    toolsDefChars?: number;
  }): number | null {
    if (!this.sessionStore) return null;
    // Largest tool_result content size (post-truncation) — surfaces tools
    // that routinely produce big outputs and benefit from smart reducers.
    let largest = 0;
    for (const b of input.toolResultBlocks) {
      const c = (b as { content?: unknown }).content;
      if (typeof c === 'string' && c.length > largest) largest = c.length;
    }
    // Pagination signal: same read_file path called 2+ times within one turn.
    let paginate = 0;
    const readFilePaths = new Map<string, number>();
    for (const b of input.toolUseBlocks) {
      if (b.name === 'read_file' || b.name === 'mcp__read_file') {
        const inp = b.input as { path?: unknown; file_path?: unknown };
        const p = typeof inp.path === 'string' ? inp.path : typeof inp.file_path === 'string' ? inp.file_path : '';
        if (p) readFilePaths.set(p, (readFilePaths.get(p) ?? 0) + 1);
      }
    }
    for (const count of readFilePaths.values()) if (count > 1) paginate += count - 1;

    const cost = estimateCost(
      this.opts.provider.name,
      this.opts.provider.model,
      input.lastUsage,
    );
    const insertedId = this.sessionStore.recordTurnTelemetry({
      session_id: this.sessionId ?? null,
      run_id: this.runId,
      turn: input.turn,
      is_subagent: this.isSubagent,
      provider: this.opts.provider.name ?? null,
      model: this.opts.provider.model ?? null,
      input_tokens: input.lastUsage?.input_tokens ?? null,
      output_tokens: input.lastUsage?.output_tokens ?? null,
      cache_read_input_tokens: input.lastUsage?.cache_read_input_tokens ?? null,
      cache_creation_input_tokens: input.lastUsage?.cache_creation_input_tokens ?? null,
      thinking_tokens: input.lastUsage?.thinking_tokens ?? null,
      history_chars: input.historyChars,
      tool_count: input.toolUseBlocks.length,
      tools_called: input.toolUseBlocks.map((b) => b.name),
      largest_tool_result_chars: input.toolResultBlocks.length > 0 ? largest : null,
      compaction_triggered: input.compactionTriggered,
      summarizer_ran: input.summarizerRan,
      paginate_count: paginate,
      system_prompt_chars: input.systemPromptChars ?? null,
      tools_def_chars: input.toolsDefChars ?? null,
      estimated_cost_usd: cost > 0 ? cost : null,
    });
    return insertedId;
  }

  constructor(opts: RunnerOptions) {
    super();
    this.opts = opts;
    this.sessionId = opts.sessionId;
    this.isSubagent = opts.isSubagent ?? false;
    this.sessionStore = opts.sessionStore;
    // Resolve the per-block tool-result cap once. Order of precedence:
    //   1. unrestricted toggle on → high safety ceiling (per main/subagent)
    //   2. explicit opts.pushTimeCap (set by subagent factories etc.)
    //   3. default constant (PUSH_TIME_CAP / SUBAGENT_PUSH_TIME_CAP)
    if (opts.unrestrictedToolOutput) {
      this.effectivePushTimeCap = this.isSubagent
        ? UNRESTRICTED_SUBAGENT_PUSH_TIME_CAP
        : UNRESTRICTED_PUSH_TIME_CAP;
    } else {
      this.effectivePushTimeCap =
        opts.pushTimeCap ?? (this.isSubagent ? SUBAGENT_PUSH_TIME_CAP : PUSH_TIME_CAP);
    }
    this.messages = (opts.initialMessages ?? []).map((m) =>
      normalizeMessageForCache(m, this.effectivePushTimeCap),
    );
    this.maxTurns = opts.maxTurns ?? 50;
    // back-reference so native interaction tools can pause the loop
    this.opts.toolContext.runner = this;
    this.opts.toolContext.planMode = opts.planMode;
    // Tier filtering: prefer explicit activeTiers, fall back to profile,
    // else null = no filtering.
    if (opts.activeTiers) {
      this.activeTiers = new Set(opts.activeTiers);
    } else if (opts.profile) {
      this.activeTiers = profileToTiers(opts.profile);
    } else {
      this.activeTiers = null;
    }
    // Seed from prior session state so the very first turn after resume can
    // already replay the previous response.
    this.previousResponseId = opts.previousResponseId ?? null;
    this.previousResponseMessageCount = opts.previousResponseMessageCount ?? null;
  }

  /**
   * Unlock a higher tier of tools. Called by the `expand_toolset` tool
   * handler. Monotonic: already-active tiers stay active, new tier is
   * added. Takes effect on the NEXT turn because the tools array is
   * rebuilt at the start of each turn from the registry + activeTiers.
   */
  promoteTier(tier: ToolTier): void {
    if (!this.activeTiers) return; // no filtering → nothing to promote
    if (this.activeTiers.has(tier)) return;
    this.activeTiers.add(tier);
    console.log(
      `[coder] tier promoted → ${tier}. Active tiers: ${Array.from(this.activeTiers).sort().join(',')}`,
    );
  }

  /**
   * Replace the session's lightweight todo list and emit `todos_updated`
   * so listeners (dashboard SSE, persistence) can react. Called by
   * `todo_write`; can also be called by host code on session resume to
   * rehydrate from the database.
   */
  setTodos(todos: import('../tools/todo.js').TodoItem[]): void {
    // Defensive copy — the tool may mutate its input later.
    this.currentTodos = todos.map((t) => ({ ...t }));
    this.emit('todos_updated', { todos: this.currentTodos });
  }

  /**
   * Build the auto-continue recap for Agent Loop v2 sessions. Returns null
   * when there is nothing worth reminding about (no goal, no todos). The
   * recap is pushed as a user message at the auto-continue boundary so the
   * model re-anchors after the summarizer collapses old history.
   */
  private buildAutoContinueRecap(): string | null {
    const ctx = this.opts.toolContext;
    const goal = ctx.getGoalState ? ctx.getGoalState() : null;
    const tasksState = ctx.getTasksState ? ctx.getTasksState() : null;
    const block = buildActiveContextBlock({
      todos: this.currentTodos,
      goal: goal
        ? {
            text: goal.text,
            status: goal.status,
            budgetTokens: goal.budgetTokens ?? null,
            completionNote: goal.completionNote ?? null,
          }
        : null,
      tasksState: tasksState ?? null,
    });
    if (!block) return null;
    return [
      '[System reminder — auto-continued]',
      'You auto-continued past the per-run turn budget. Re-anchor on the live state below before acting; if the goal is already complete, emit a final message and stop.',
      '',
      block,
    ].join('\n');
  }

  /** True iff at least one todo in the live list is `pending` or `in_progress`. */
  private hasUnfinishedTodos(): boolean {
    for (const t of this.currentTodos) {
      if (t.status === 'pending' || t.status === 'in_progress') return true;
    }
    return false;
  }

  /**
   * Build the recap pushed back when the stop-guard fires. Lists every
   * unfinished todo and tells the model what its options are. Mirrors the
   * "all items completed or explicitly canceled/deferred before ending the
   * turn" rule we surface in the system prompt.
   */
  private buildStopGuardRecap(): string {
    const unfinished = this.currentTodos.filter(
      (t) => t.status === 'pending' || t.status === 'in_progress',
    );
    const lines = unfinished.map((t) => {
      const label = t.status === 'in_progress' ? t.activeForm : t.content;
      return `  - [${t.status}] ${label}`;
    });
    return [
      '[System reminder — agent loop]',
      'You signaled completion, but the live todo list still has unfinished items:',
      ...lines,
      '',
      'Before stopping, do ONE of the following:',
      '  1. Finish the remaining items, then call todo_write to mark them completed and emit a final message.',
      '  2. If an item is no longer applicable, call todo_write to remove it (do not silently leave it pending) and explain why in your final message.',
      '  3. If you are blocked on a user decision, call ask_user — do not stop silently.',
      '',
      'This is your one and only nudge for this session — the next stop will go through.',
    ].join('\n');
  }

  /**
   * Build the messages array passed to provider.chat() for the current turn.
   * When `agentLoopV2` is on, appends a live `<active-context>` text block to
   * the trailing user message (or creates a synthetic one if the history
   * doesn't end on a user message). The block is rebuilt every turn from
   * live state and is NEVER persisted into `this.messages` — it lives only in
   * the request payload, so the cached prefix stays byte-stable.
   */
  private assembleMessagesForChat(
    compactionLimits: import('./compaction.js').CompactionLimits | undefined,
  ): AgentMessage[] {
    const compacted = compactHistoryForLLM(this.messages, compactionLimits);
    if (!this.opts.agentLoopV2) return compacted;

    const ctx = this.opts.toolContext;
    const goal = ctx.getGoalState ? ctx.getGoalState() : null;
    const tasksState = ctx.getTasksState ? ctx.getTasksState() : null;
    const block = buildActiveContextBlock({
      todos: this.currentTodos,
      goal: goal
        ? {
            text: goal.text,
            status: goal.status,
            budgetTokens: goal.budgetTokens ?? null,
            completionNote: goal.completionNote ?? null,
          }
        : null,
      tasksState: tasksState ?? null,
    });
    if (!block) return compacted;

    // Append as a TextBlock to the last user message — safer than adding a
    // new message because Anthropic disallows two adjacent user messages.
    // If the history ends on an assistant message (rare — only if a turn
    // emitted text and no tool calls but somehow we still loop), append a
    // brand-new user message instead.
    const cloned = compacted.slice();
    const lastIdx = cloned.length - 1;
    if (lastIdx >= 0 && cloned[lastIdx].role === 'user') {
      const last = cloned[lastIdx];
      cloned[lastIdx] = {
        role: 'user',
        content: [...last.content, { type: 'text', text: block } as ContentBlock],
      };
    } else {
      cloned.push({ role: 'user', content: [{ type: 'text', text: block } as ContentBlock] });
    }
    return cloned;
  }

  /**
   * Enter a git worktree scope. Swaps the runner's tool-context cwd for the
   * worktree path so every subsequent tool call (fs, shell, git, LSP, glob)
   * operates against the worktree. Remembers the original root so
   * `exitWorktreeScope` can restore it. Emits `worktree_entered`.
   */
  enterWorktreeScope(absWorktreePath: string): void {
    if (this.worktreePath) return; // already inside — no-op, tool enforces this
    this.originalCwd = this.opts.toolContext.cwd;
    this.worktreePath = absWorktreePath;
    this.opts.toolContext.cwd = absWorktreePath;
    this.emit('worktree_entered', { path: absWorktreePath, originalCwd: this.originalCwd });
  }

  /**
   * Exit the current worktree scope. Restores the original cwd so subsequent
   * tool calls go back to the project root. Leaves the worktree directory on
   * disk — the tool handler decides whether to git-remove it after.
   */
  exitWorktreeScope(): void {
    if (!this.worktreePath || !this.originalCwd) return;
    const wasAt = this.worktreePath;
    this.opts.toolContext.cwd = this.originalCwd;
    this.worktreePath = null;
    this.originalCwd = null;
    this.emit('worktree_exited', { path: wasAt });
  }

  get provider(): ChatProvider {
    return this.opts.provider;
  }

  /**
   * Snapshot of the tools currently registered on this runner. Used by tools
   * that need to spawn a subagent (spawn_subagent, execute_task subagent
   * mode) so the child can build a filtered subset registry. Returns a fresh
   * array each call so callers can mutate it freely.
   */
  getToolListSnapshot(): import('./tool.js').CoderTool[] {
    return this.opts.registry.list();
  }

  get planMode(): boolean {
    return Boolean(this.opts.planMode);
  }

  /** Public method form for tools that prefer call-syntax over property-access. */
  isPlanMode(): boolean {
    return Boolean(this.opts.planMode);
  }

  /**
   * Active agent identity at run start, if any. Read-only — the in-memory
   * agent never changes mid-run; mode transitions persist to the DB and
   * take effect on the NEXT runner creation. Tools use this to decide
   * whether a transition (e.g. plan→build after approval) should fire.
   */
  get agentId(): import('../agents/index.js').AgentId | null | undefined {
    return this.opts.agentId;
  }

  /**
   * Append a `<system-reminder>` wrapped user message to the conversation.
   * Used by tools that need to nudge the model out-of-band (e.g. mode
   * transition after plan approval). Mirrors to the SessionStore when
   * available so the reminder survives compaction and run resume.
   */
  appendSystemReminder(text: string): void {
    const msg: AgentMessage = {
      role: 'user',
      content: [{ type: 'text', text: `<system-reminder>${text}</system-reminder>` }],
    };
    this.messages.push(msg);
    if (this.opts.sessionStore && this.opts.sessionId !== undefined) {
      try {
        this.opts.sessionStore.appendMessage(this.opts.sessionId, msg);
      } catch (e) {
        console.warn(
          `[coder] appendSystemReminder mirror failed: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
  }

  /** Replace the active provider mid-session. Takes effect on the next turn. */
  swapProvider(newProvider: ChatProvider): void {
    this.opts.provider = newProvider;
    this.emit('provider_swapped', newProvider.name, newProvider.model);
  }

  /** Pause the current tool call, waiting for the host (CLI/SSE) to call provideUserInput. */
  waitForUserInput(): Promise<string> {
    return new Promise((resolve) => {
      this.pendingResolve = resolve;
    });
  }

  /** Resume a paused tool call with the user's answer. */
  provideUserInput(value: string): boolean {
    if (!this.pendingResolve) return false;
    const r = this.pendingResolve;
    this.pendingResolve = null;
    r(value);
    return true;
  }

  /** True while the runner is blocked inside waitForUserInput(). */
  isWaitingForInput(): boolean {
    return this.pendingResolve !== null;
  }

  /**
   * Break a pending waitForUserInput() by resolving it with an interrupt
   * signal. The blocked tool receives { interrupted: true, ...info } and
   * should return an error result so the master can handle the urgent
   * request (e.g. a subordinate blocked on ask_master) before re-asking.
   *
   * Optional `info` is forwarded so blocked tools can surface a structured
   * `next_action` to the agent (which subordinate, which master tool to
   * call) instead of relying on a notification user-message arriving in
   * time.
   */
  interruptWait(info?: { kind?: 'plan' | 'question' | 'tasks' | 'subordinate_event'; agentRunId?: number; role?: string }): boolean {
    if (!this.pendingResolve) return false;
    const r = this.pendingResolve;
    this.pendingResolve = null;
    r(JSON.stringify({ interrupted: true, ...(info ?? {}) }));
    return true;
  }

  /** Marks the latest plan as approved so mutating tools become unblocked. */
  approvePlan(): void {
    this.planApproved = true;
  }

  /** Whether mutating tools should be allowed right now. */
  isPlanApproved(): boolean {
    return this.planApproved;
  }

  // ─── Tasks scope (Phase 1: inline mode) ─────────────────────

  /** Marks the submitted task list as approved by the user. Counts as a
   *  satisfied plan-mode nudge but does NOT unlock mutating tools globally. */
  markTasksApproved(): void {
    this.tasksApproved = true;
  }

  isTasksApproved(): boolean {
    return this.tasksApproved;
  }

  /** Open an inline task scope. While active, mutating tools may run for
   *  paths inside `files` even when planMode is true and planApproved is false. */
  beginTaskScope(scope: { id: string; files: string[] }): void {
    this.currentTaskScope = { id: scope.id, files: [...scope.files] };
  }

  /** Close the inline task scope. Mutating tools become blocked again
   *  (unless planApproved or another scope is opened). */
  endTaskScope(): void {
    this.currentTaskScope = null;
  }

  /** True iff an inline task scope is currently open. */
  isInTaskScope(): boolean {
    return this.currentTaskScope !== null;
  }

  /** The id of the inline task currently being executed (or null). */
  currentTaskScopeId(): string | null {
    return this.currentTaskScope?.id ?? null;
  }

  /** The files declared by the inline task currently being executed (or null). */
  currentTaskScopeFiles(): string[] | null {
    return this.currentTaskScope ? [...this.currentTaskScope.files] : null;
  }

  abort(): void {
    this.aborted = true;
    if (this.pendingResolve) {
      const r = this.pendingResolve;
      this.pendingResolve = null;
      r(JSON.stringify({ aborted: true }));
    }
  }

  on<K extends keyof RunnerEvents>(event: K, listener: RunnerEvents[K]): this {
    return super.on(event, listener as (...args: unknown[]) => void);
  }

  emit<K extends keyof RunnerEvents>(event: K, ...args: Parameters<RunnerEvents[K]>): boolean {
    return super.emit(event, ...args);
  }

  /**
   * Append a user message (text only). Messages are buffered and flushed at
   * the start of the next turn so they never land mid-turn between an
   * assistant tool_use block and its tool_result — which would produce an
   * invalid message sequence for the LLM API.
   */
  pushUserMessage(text: string): void {
    this.pendingUserMessages.push(text);
  }

  private flushPendingMessages(): void {
    while (this.pendingUserMessages.length > 0) {
      const text = this.pendingUserMessages.shift()!;
      this.messages.push({ role: 'user', content: [{ type: 'text', text }] });
    }
  }

  /** Append a user message with arbitrary content blocks (text + image + document). */
  pushUserContent(blocks: ContentBlock[]): void {
    this.messages.push({ role: 'user', content: blocks });
  }

  /**
   * Toggle extended-thinking (deep reasoning) for subsequent turns. The next
   * `ChatRequest` reads `this.opts.thinking` so the change takes effect on the
   * next turn without rebuilding the runner. Called by `sendMessageToMaster`
   * and `forward_to_agent` when the user/master wants to flip thinking on/off
   * for a live runner that's already past construction.
   */
  setThinking(value: boolean | undefined): void {
    this.opts = { ...this.opts, thinking: value };
  }

  /**
   * Run the loop until completion or max_turns. Resolves with the final usage
   * total. The runner emits events along the way; consumers (CLI / SSE) attach
   * listeners before calling run().
   */
  async run(): Promise<RunResult> {
    const totalUsage: ChatUsage = {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    };
    this.emit('run_started', {
      runId: this.runId,
      provider: this.opts.provider.name ?? 'unknown',
      model: this.opts.provider.model ?? 'unknown',
      profile: this.activeTiers ? Array.from(this.activeTiers).sort().join(',') : null,
      planMode: !!this.opts.planMode,
      maxTurns: this.maxTurns,
    });
    let autoContinueCount = 0;
    // Tools array is rebuilt each turn when tier filtering is active, so
    // `expand_toolset` calls take effect on the very next turn without any
    // extra plumbing. When `activeTiers` is null (subagents, tests) we
    // compute it once and reuse — identical to the legacy behaviour.
    const buildTools = () => {
      let filtered = this.opts.registry.list();
      // Global disabled (admin panel)
      if (this.opts.globalDisabledTools?.size) {
        filtered = filtered.filter((t) => !this.opts.globalDisabledTools!.has(t.name));
      }
      // Session disabled (per-session config)
      if (this.opts.sessionDisabledTools?.size) {
        filtered = filtered.filter((t) => !this.opts.sessionDisabledTools!.has(t.name));
      }
      // Tier filtering (with optional runtime overrides for external MCP tools)
      filtered = this.activeTiers
        ? filterByTiers(filtered, this.activeTiers, this.opts.externalToolTiers)
        : filtered;
      // Plugin hook: projects can drop `.mcp-indexer/hooks/tool-filter.js`
      // to return an allowlist of tool names. Runs in vm sandbox with 200ms
      // timeout; on failure or non-array return, no filtering is applied.
      const hookAllow = runToolFilterHook(
        this.opts.toolContext.cwd,
        filtered.map((t) => ({ name: t.name, source: t.source })),
        {
          projectName: this.opts.toolContext.projectName,
          providerName: this.opts.provider.name,
          model: this.opts.provider.model,
          profile: this.activeTiers ? Array.from(this.activeTiers).sort().join(',') : undefined,
        },
      );
      if (hookAllow && hookAllow.size > 0) {
        const before = filtered.length;
        filtered = filtered.filter((t) => hookAllow.has(t.name));
        if (filtered.length < before) {
          console.log(`[coder] tool-filter hook removed ${before - filtered.length} tool(s)`);
        }
      }
      // Hide `create_goal` when an in-progress goal exists. Eliminates the
      // loop seen in sessions 656/658 where the model kept calling
      // create_goal instead of executing real work. Read fresh each turn
      // — `update_goal` flipping status to 'complete' re-exposes the tool
      // automatically on the next turn, preserving legitimate pivots.
      const activeGoal = this.opts.toolContext.getGoalState?.();
      if (activeGoal && activeGoal.status === 'in_progress') {
        const before = filtered.length;
        filtered = filterGoalToolsByState(filtered, activeGoal);
        if (filtered.length < before && !this.goalToolHiddenLogged) {
          this.goalToolHiddenLogged = true;
          const preview = activeGoal.text.length > 80
            ? `${activeGoal.text.slice(0, 80)}…`
            : activeGoal.text;
          console.log(`[coder] hiding create_goal — active goal: "${preview}"`);
        }
      } else {
        this.goalToolHiddenLogged = false;
      }
      // Stable alphabetical sort. The provider sees the tools array in
      // every request; any reordering between turns invalidates server-side
      // prompt caches (Anthropic ephemeral, OpenAI/ZAI auto-cache). Sorting
      // by name eliminates the dependency on registry insertion order, hot-
      // reload sequencing of MCP tools, or filter pass ordering.
      filtered = filtered.slice().sort((a, b) => a.name.localeCompare(b.name));
      const maxTools = getModelMaxTools(this.opts.provider.model ?? '');
      if (filtered.length > maxTools) {
        console.log(`[coder] tool cap: ${filtered.length} → ${maxTools} (model limit for ${this.opts.provider.model})`);
        filtered = filtered.slice(0, maxTools);
      }
      // Bootstrap-only profile: aggressively shorten descriptions to their
      // first sentence. The bootstrap turn is the most expensive (no cache
      // warmth yet) and the agent only needs to know which tool routes
      // where — full USE/DON'T text becomes useful only after promotion.
      const bootstrapOnly = !!this.activeTiers
        && !this.activeTiers.has('navigate')
        && !this.activeTiers.has('admin');
      return filtered.map((t) => ({
        name: t.name,
        description: bootstrapOnly ? terseDescription(t.description) : t.description,
        parameters: t.parameters,
      }));
    };
    let tools = buildTools();
    if (this.opts.registry.has('post_to_board') || this.opts.registry.has('read_board')) {
      console.log(
        `[coder] company board tools visible: post_to_board=${tools.some((t) => t.name === 'post_to_board')} ` +
        `read_board=${tools.some((t) => t.name === 'read_board')}`,
      );
    }

    // Persist a manifest of the tools array (Camada 3 follow-up — was
    // formerly the full JSON, ~5–20KB per tier change). The dashboard only
    // needs `tool_count` + `chars` to render the first-turn breakdown; the
    // per-turn evolution lives in `coder_turn_telemetry.tools_def_chars`
    // (richer signal than the deduped session-input row anyway).
    //
    // The recorded `content` is a stable fingerprint (sha1 of the tools
    // JSON) so SessionStore.recordSessionInput's content-hash dedup keeps
    // working: same fingerprint = no new row, tier promotion = new row.
    // Real chars/byte count travels via `meta.content_chars`.
    if (this.sessionStore && this.sessionId != null) {
      try {
        const toolsJson = JSON.stringify(tools);
        const fingerprint = createHash('sha1').update(toolsJson).digest('hex');
        this.sessionStore.recordSessionInput({
          session_id: this.sessionId,
          kind: 'tools_snapshot',
          source_label: 'turn-start',
          content: fingerprint,
          meta: {
            tool_count: tools.length,
            tool_names: tools.map((t) => t.name),
            profile: this.activeTiers ? Array.from(this.activeTiers).sort().join(',') : 'all',
            content_chars: toolsJson.length,
            // Mark the new schema so the dashboard can fall back to legacy
            // (content = full JSON) for sessions recorded before this change.
            schema: 'manifest-v1',
          },
        });
      } catch {
        /* best-effort */
      }
    }
    /**
     * Compute the cache-key that drives buildTools() re-runs. Originally
     * just the active tier set — added goal-state because the tools array
     * was being reused across turns and thus never re-applied the
     * `filterGoalToolsByState` filter once a goal was set mid-session
     * (sessions 656/658/664: agent called create_goal in turn 1 with no
     * goal, the cached tools array kept create_goal visible for every
     * subsequent turn, model looped on it).
     *
     * Goal contributes only its STATUS (`null`/`in_progress`/`complete`),
     * not the goal text, so prefix caches stay byte-stable across turns
     * within the same status. The status only flips a few times per
     * session (when create_goal/update_goal fires), so cache thrash is
     * bounded.
     */
    const buildToolsCacheKey = (): string => {
      const tierKey = this.activeTiers ? Array.from(this.activeTiers).sort().join(',') : '*';
      const goalStatus = this.opts.toolContext.getGoalState?.()?.status ?? 'none';
      return `${tierKey}|goal=${goalStatus}`;
    };
    let lastTiersKey = buildToolsCacheKey();

    let turn = 0;
    // In plan mode: allows ONE automatic nudge when the model writes intent text
    // without calling tools mid-investigation. Prevents premature session end.
    let planNudgeSent = false;
    // Tracks the actual input_tokens count from the last API response so the
    // compaction trigger can use real token counts instead of char estimates.
    let lastKnownInputTokens: number | null = null;
    // Number of messages in `this.messages` at the moment lastKnownInputTokens
    // was reported. Lets `computeSnapshot` distinguish the confirmed prefix
    // from the locally-estimated tail.
    let lastUsageMessageCount = 0;
    // Circuit breaker for repeated compaction failures (summariser + fallback).
    // After this many consecutive failures, the loop bails with an error
    // instead of looping forever on a broken context.
    const MAX_CONSECUTIVE_COMPACT_FAILURES = 3;
    let consecutiveCompactFailures = 0;
    // Derive compaction thresholds from the model's context window once per session.
    const compactionLimits = deriveCompactionLimits(this.opts.context_window);
    // Token-mode limits (used when CODER_NEW_COMPACTION is on). Falls back to
    // the legacy compactionLimits when no model id is available.
    const newPath = isNewCompactionEnabled();
    const modelId = this.opts.provider.model ?? '';
    const tokenLimits = newPath && modelId ? deriveTokenLimits(modelId) : null;
    if (tokenLimits) {
      console.log(
        `[coder] new compaction path: model=${modelId} window=${tokenLimits.rawWindow} ` +
        `effective=${tokenLimits.effective} trigger=${tokenLimits.trigger} protect=${tokenLimits.protect}` +
        (tokenLimits.isFallback ? ' (FALLBACK — model not in registry)' : ''),
      );
    }
    /** Compute a fresh hybrid token snapshot for the current `this.messages`. */
    const computeTokenSnapshot = (): TokenSnapshot => {
      const usage = lastKnownInputTokens != null
        ? { input_tokens: lastKnownInputTokens, messageCountAtTime: lastUsageMessageCount }
        : null;
      return computeSnapshot(this.messages, usage);
    };
    // Outer loop: allows auto-continue after maxTurns by resetting `turn`.
    // eslint-disable-next-line no-constant-condition
    while (true) {
      while (turn < this.maxTurns) {
        this.flushPendingMessages();
        if (this.aborted) {
          return this.finishWith(totalUsage, 'aborted');
        }

        turn++;
        this.turn = turn;
        this.emit('turn_start', turn);

        // Periodically remind subordinate agents to post a deliverable before stopping.
        if (this.opts.isCompanySubordinate && turn > 1 && turn % SUBORDINATE_REMINDER_INTERVAL === 0) {
          this.messages.push({ role: 'user', content: [{ type: 'text', text: SUBORDINATE_REMINDER_MSG }], isMeta: true });
          this.logSystemReminder('subordinate-deliverable', SUBORDINATE_REMINDER_MSG);
          if (this.opts.companyRoleOverride) {
            const text = `[System reminder — Role identity] ${this.opts.companyRoleOverride}`;
            this.messages.push({ role: 'user', content: [{ type: 'text', text }], isMeta: true });
            this.logSystemReminder('role-identity', text);
          }
        }

        // Per-turn telemetry flags — captured below by persistTurnTelemetry.
        let summarizerRanThisTurn = false;
        let compactionTriggeredThisTurn = false;

        // LLM summarizer — opt-in via CODER_SUMMARIZER_ENABLE=1. Runs ONCE
        // per session the first turn the history grows big enough to trigger
        // compaction. Replaces the pre-cutoff span with a single synthetic
        // assistant message containing a structured markdown summary. Any
        // failure (LLM error, bad JSON, timeout) falls back to the
        // deterministic compactMessages path below — the summarizer never
        // breaks a turn.
        if (isSummarizerEnabled() && !this.summarizedOnce) {
          // Token-mode (new): use the hybrid TokenSnapshot vs effective window.
          // Char-mode (legacy): keep the original char-threshold path so we
          // can A/B with CODER_NEW_COMPACTION=0.
          let shouldCompactNow = false;
          let triggerLog = '';
          if (tokenLimits) {
            const snap = computeTokenSnapshot();
            shouldCompactNow = snap.total >= tokenLimits.trigger;
            triggerLog = `tokens=${snap.total} (${snap.source}, conf=${snap.confirmed} est=${snap.pendingEstimate}) trigger=${tokenLimits.trigger}`;
          } else {
            const total = totalChars(this.messages);
            shouldCompactNow =
              compactionLimits.triggerTokens !== null && lastKnownInputTokens !== null
                ? lastKnownInputTokens >= compactionLimits.triggerTokens
                : total > compactionLimits.minimum;
            triggerLog = `chars=${total} (legacy)`;
          }
          if (shouldCompactNow) {
            compactionTriggeredThisTurn = true;
            const protectArg = tokenLimits ? tokenLimits.protect : compactionLimits.protect;
            const rawCutoff = tokenLimits
              ? computeCutoffIndexByTokens(this.messages, tokenLimits.protect)
              : computeCutoffIndex(this.messages, compactionLimits.protect);
            // PR-3 (R4): when v2 is on, recede the cutoff so at least N
            // user-message turns remain raw past the boundary. Keeps recent
            // user-intent verbatim — the summarizer paraphrases everything
            // before. Pair-preserving snap runs after so atomic
            // tool_use/tool_result groups still aren't split.
            const recededCutoff = this.opts.agentLoopV2
              ? recedeToPreserveLastNTurns(this.messages, rawCutoff, preserveLastNTurns())
              : rawCutoff;
            const cutoff = tokenLimits
              ? snapCutoffPreservingPairs(this.messages, recededCutoff)
              : snapCutoffToRoleBoundary(this.messages, recededCutoff);
            if (cutoff > 1) {
              const span = this.messages.slice(0, cutoff);
              console.log(`[coder] running summarizer on ${cutoff} old messages — ${triggerLog} protect=${protectArg}`);
              const summaryRaw = isStructuredSummaryEnabled()
                ? await summarizeSpanV2(span, this.opts.provider).catch(() => null)
                : await summarizeSpan(span, this.opts.provider).catch(() => null);
              const summary = this.opts.agentLoopV2 && summaryRaw && 'primary_request' in summaryRaw
                ? overlayLiveState(
                    summaryRaw,
                    this.currentTodos,
                    this.opts.toolContext.getGoalState
                      ? (() => {
                          const g = this.opts.toolContext.getGoalState!();
                          return g ? { text: g.text, status: g.status } : null;
                        })()
                      : null,
                  )
                : summaryRaw;
              if (summary) {
                const rendered = 'primary_request' in summary
                  ? renderSummaryV2(summary)
                  : renderSummary(summary);
                const syntheticAssistant: AgentMessage = {
                  role: 'assistant',
                  content: [{ type: 'text', text: rendered }],
                };
                // Replace the pre-cutoff span with the synthetic summary. The
                // persistent DB history is NOT touched — only the in-memory
                // `this.messages` used to build provider requests. A session
                // resume will rebuild from the untouched DB and re-apply the
                // deterministic compaction path.
                this.messages.splice(0, cutoff, syntheticAssistant);
                // Run post-compact dedup pass — eliminate read tool_result
                // duplicates whose content is now also implicit in the summary.
                if (tokenLimits) {
                  const cleaned = postCompactCleanup(this.messages);
                  if (cleaned.elidedReads > 0) {
                    this.messages.length = 0;
                    this.messages.push(...cleaned.messages);
                    console.log(`[coder] post-compact dedup elided ${cleaned.elidedReads} read(s) (~${cleaned.freedChars} chars freed)`);
                  }
                }
                this.summarizedOnce = true;
                summarizerRanThisTurn = true;
                consecutiveCompactFailures = 0;
                // Confirmed token count is no longer authoritative — we just
                // rewrote the prefix. Force a re-measurement on next turn.
                lastKnownInputTokens = null;
                lastUsageMessageCount = 0;
                console.log(`[coder] summarizer collapsed ${cutoff} messages into 1 synthetic summary`);
              } else {
                // Mark as attempted so we don't retry every turn on a broken
                // summarizer — deterministic compaction takes over.
                this.summarizedOnce = true;
                consecutiveCompactFailures++;
                console.warn(`[coder] summarizer returned null; using deterministic compaction (failures=${consecutiveCompactFailures})`);
                if (consecutiveCompactFailures >= MAX_CONSECUTIVE_COMPACT_FAILURES) {
                  console.error(`[coder] giving up after ${consecutiveCompactFailures} consecutive compaction failures`);
                  // Mirror into the unified circuit-breaker telemetry pipeline
                  // (PR-2, R1) without changing the existing abort semantics.
                  this.emit('recovery_aborted', {
                    kind: 'compact-failure',
                    attempts: consecutiveCompactFailures,
                    cap: MAX_CONSECUTIVE_COMPACT_FAILURES,
                    contextHint: 'summarizer-null-pre-turn',
                  });
                  this.setTransition('compact-pre-turn');
                  return this.finishWith(totalUsage, 'compact_failure');
                }
              }
            }
          }
        }

        // Rebuild tools iff the cache key changed since last turn (tier
        // set OR goal-status flip). Cheap no-op otherwise — keeps the
        // prefix byte-stable across consecutive turns within the same
        // (tier, goal-status), so server-side prefix cache hits.
        const currentKey = buildToolsCacheKey();
        if (currentKey !== lastTiersKey) {
          tools = buildTools();
          lastTiersKey = currentKey;
        }

        // PhaseRouter (Camada 2 — Phase Profiles) was REMOVED. Mid-turn
        // model swaps proved too disruptive: cache invalidation, latency
        // jitter, and confusing behavior between rounds. Sessions now run
        // on a single (provider, model) for their entire lifetime — the
        // legacy contract before Sprint 3.

        const assistantContent: ContentBlock[] = [];
        let pendingText = '';
        const pendingToolCalls = new Map<string, { name: string; input: Record<string, unknown> }>();
        const usageBox: { value: ChatUsage | null } = { value: null };
        let retriedThisTurn = false;
        // PR-2 (R5): per-turn counter for exp+jitter transient retries
        // (429 / 5xx / timeout). Resets each turn; provider swaps via
        // fallback chain also reset it (new provider, fresh budget).
        let transientRetryAttempts = 0;
        let pendingThinking = '';
        const pendingImages: Array<{ mediaType: string; base64: string }> = [];
        void assistantContent;

        this.emit('provider_call', {
          runId: this.runId,
          turn,
          provider: this.opts.provider.name ?? 'unknown',
          model: this.opts.provider.model ?? 'unknown',
          toolCount: tools.length,
          historyChars: totalChars(this.messages),
        });

        const tempResolution = resolveTemperature({
          agent: this.opts.agentId ?? null,
          providerName: this.opts.provider.name ?? '',
          model: this.opts.provider.model ?? '',
          thinking: this.opts.thinking,
          sessionOverride: this.opts.sessionTemperature,
          roleOverride: this.opts.roleTemperature,
        });
        this.emit('temperature_resolved', {
          runId: this.runId,
          turn,
          provider: this.opts.provider.name ?? 'unknown',
          model: this.opts.provider.model ?? 'unknown',
          agent: this.opts.agentId ?? null,
          temperature: tempResolution.temperature,
          source: tempResolution.source,
          reason: tempResolution.reason,
        });

        providerAttempt: while (true) {
          try {
            const messagesForChat = this.assembleMessagesForChat(compactionLimits);
            const stream = this.opts.provider.chat({
              system: this.opts.systemPrompt,
              messages: messagesForChat,
              tools,
              thinking: this.opts.thinking,
              sessionId: this.opts.sessionId,
              ...(typeof tempResolution.temperature === 'number'
                ? { inference: { temperature: tempResolution.temperature } }
                : {}),
              ...(this.previousResponseId
                ? {
                  previousResponseId: this.previousResponseId,
                  previousResponseMessageCount: this.previousResponseMessageCount ?? 0,
                }
                : {}),
            });
            for await (const delta of stream) {
              if (this.aborted) break;
              this.handleDelta(delta, {
                onText: (t) => {
                  pendingText += t;
                  this.emit('text_delta', t);
                },
                onThinking: (t) => {
                  pendingThinking += t;
                  this.emit('thinking_delta', t);
                },
                onToolCall: (id, name, input) => {
                  pendingToolCalls.set(id, { name, input });
                },
                onUsage: (u) => {
                  usageBox.value = u;
                },
                onResponseId: (id, messageCount) => {
                  this.previousResponseId = id;
                  this.previousResponseMessageCount = messageCount;
                  this.opts.onResponseId?.(id, messageCount);
                },
                onImageGenerated: (mediaType, base64) => {
                  pendingImages.push({ mediaType, base64 });
                },
              });
            }
            break;
          } catch (e) {
            const error = e instanceof Error ? e : new Error(String(e));
            const status = (e as { status?: number }).status;
            const code = (e as { error?: { code?: string } }).error?.code;
            const nonRetryableReason = nonRetryableProviderErrorReason(error, e);
            const is400 = !nonRetryableReason && (status === 400 || code === '1214');
            const is401 = status === 401;
            const is429 = status === 429;
            const isTimeout = error.message?.includes('timeout') || status === 504 || status === 408;
            const is5xx = status !== undefined && status >= 500 && status < 600;
            const isTransient = is429 || is5xx || isTimeout;

            if (nonRetryableReason) {
              console.warn(
                `[coder] provider returned non-retryable error at turn ${turn}: ${nonRetryableReason}`,
              );
            }

            // ─── 400: format-error retry (existing semantics) ────────────
            // GLM/ZAI returns code 1214 for illegal message sequences that
            // may be fixable by the compaction safety nets on a second pass.
            // Single retry per turn (cheap), session cap via circuit breaker.
            if (is400 && !retriedThisTurn) {
              if (!this.tryRecord('provider-400-retry', `turn=${turn}`)) {
                this.setTransition('provider-400-retry');
                return this.finishWith(totalUsage, 'recovery_capped', new Error(
                  `Aborted: too many 400/format-error retries this session (cap=${recoveryCap('provider-400-retry')}). Last: ${error.message}`,
                ));
              }
              this.setTransition('provider-400-retry');
              retriedThisTurn = true;
              console.warn(`[coder] provider returned 400 at turn ${turn}, retrying once`);
              continue providerAttempt;
            }

            // ─── 401: OAuth refresh ───────────────────────────────────────
            // Re-create the provider to force a credential refresh, then
            // retry. Cap at RECOVERY_401 across the session — refresh
            // failing repeatedly means the credential itself is bad.
            if (is401 && !retriedThisTurn && this.opts.createProvider) {
              if (!this.tryRecord('provider-401-refresh', `turn=${turn}`)) {
                this.setTransition('provider-401-refresh');
                return this.finishWith(totalUsage, 'recovery_capped', new Error(
                  `Aborted: too many OAuth refresh attempts (cap=${recoveryCap('provider-401-refresh')}). Re-authenticate via the admin panel. Last: ${error.message}`,
                ));
              }
              this.setTransition('provider-401-refresh');
              retriedThisTurn = true;
              try {
                const newProvider = await this.opts.createProvider(
                  this.opts.provider.name,
                  this.opts.provider.model,
                );
                this.swapProvider(newProvider);
                console.warn(`[coder] 401 on turn ${turn} — refreshed OAuth credentials, retrying`);
                continue providerAttempt;
              } catch (refreshErr) {
                console.error(
                  `[coder] credential refresh failed after 401: ${refreshErr instanceof Error ? refreshErr.message : String(refreshErr)}`,
                );
              }
            }

            // ─── Transient (429/5xx/timeout): exp+jitter retry (R5) ────
            // Bounded retries WITHIN the same provider before falling
            // through to the fallback chain. Mirrors kimi-cli's tenacity
            // setup (initial=300ms, max=5s, jitter=0.5, max attempts=3
            // per turn). Each attempt also bumps the session cap so a
            // server that's been 5xx-ing for 30 turns straight bails.
            const transientCap = transientRetryMaxPerTurn();
            if (isTransient && transientRetryAttempts < transientCap) {
              if (!this.tryRecord('provider-transient-retry', `turn=${turn} status=${status ?? '?'}`)) {
                this.setTransition('provider-transient-retry');
                return this.finishWith(totalUsage, 'recovery_capped', new Error(
                  `Aborted: too many transient errors this session (cap=${recoveryCap('provider-transient-retry')}). Last status=${status ?? '?'}: ${error.message}`,
                ));
              }
              this.setTransition('provider-transient-retry');
              transientRetryAttempts++;
              const delay = backoffDelayMs(transientRetryAttempts);
              console.warn(
                `[coder] transient ${status ?? 'timeout'} at turn ${turn} attempt ${transientRetryAttempts}/${transientCap}; sleeping ${delay}ms`,
              );
              await new Promise((r) => setTimeout(r, delay));
              continue providerAttempt;
            }

            // ─── Fallback chain (after retries exhausted) ────────────────
            // Trigger on: 400 after retry, 401 without refresh, transient
            // after R5 retries exhausted. Capped by RECOVERY_FALLBACK so a
            // session can't hop providers indefinitely.
            const shouldFallback = (is400 && retriedThisTurn) || is401 || isTransient;
            if (shouldFallback && this.opts.fallbackChain && this.opts.createProvider) {
              if (!this.tryRecord('provider-fallback', `from=${this.opts.provider.name ?? 'unknown'}`)) {
                this.setTransition('provider-fallback');
                return this.finishWith(totalUsage, 'recovery_capped', new Error(
                  `Aborted: provider fallback chain exhausted (cap=${recoveryCap('provider-fallback')}). Last: ${error.message}`,
                ));
              }
              const { nextFallback } = await import('./fallback.js');
              const next = nextFallback(this.opts.fallbackChain);
              if (next) {
                const oldProvider = { provider: this.opts.provider.name ?? 'unknown', model: this.opts.provider.model ?? 'unknown' };
                try {
                  const newProvider = await this.opts.createProvider(next.provider, next.model);
                  this.swapProvider(newProvider);
                  console.warn(`[coder] Fallback activated: ${oldProvider.provider}/${oldProvider.model} → ${next.provider}/${next.model} (error: ${error.message})`);
                  this.emit('fallback_activated', {
                    from: oldProvider,
                    to: next,
                    error: error.message,
                  });
                  // Fire hook
                  // PR-6 R24: fallback is session-scoped — suppress for subagents.
                  if (!this.isSubagent) {
                    await this.opts.hookRegistry?.fireFallback({
                      sessionId: 0, projectName: '', provider: next.provider, model: next.model, turn,
                      from: oldProvider,
                      to: next,
                      triggerError: error.message,
                    });
                  }
                  // Reset per-turn transient counter — new provider gets a
                  // fresh budget. Session cap still in effect.
                  transientRetryAttempts = 0;
                  retriedThisTurn = false;
                  this.setTransition('provider-fallback');
                  continue providerAttempt; // retry the turn with the new provider
                } catch (fallbackErr) {
                  console.error(`[coder] Fallback provider creation failed: ${fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr)}`);
                }
              }
            }

            // Fire error hook before giving up.
            // PR-6 (Row 24): session-scoped hooks (error/completion/fallback)
            // are suppressed for subagents — the parent runner is the
            // session-of-record. Tool-scoped hooks (fireToolCall) keep
            // running so policy enforcement applies uniformly. Today the
            // subagent factories don't pass hookRegistry so this guard is
            // belt-and-suspenders, but it documents the contract for any
            // future contributor who DOES wire it through.
            if (!this.isSubagent) {
              await this.opts.hookRegistry?.fireError({
                sessionId: 0, projectName: '', provider: this.opts.provider.name ?? 'unknown',
                model: this.opts.provider.model ?? 'unknown', turn,
                error, errorType: 'provider', willRetry: false, willFallback: false,
              });
            }

            return this.finishWith(totalUsage, 'error', error);
          }
        }

        // Build assistant message in correct block order: thinking first, text,
        // generated images, then tool_uses
        if (pendingThinking) {
          assistantContent.push({ type: 'thinking', text: pendingThinking });
        }
        if (pendingText) {
          assistantContent.push({ type: 'text', text: pendingText });
        }
        for (const img of pendingImages) {
          assistantContent.push({ type: 'image', mediaType: img.mediaType, base64: img.base64 });
        }
        const toolUseBlocks: ToolUseBlock[] = [];
        for (const [id, { name, input }] of pendingToolCalls) {
          const block: ToolUseBlock = { type: 'tool_use', id, name, input };
          toolUseBlocks.push(block);
          assistantContent.push(block);
        }

        const assistantMessage: AgentMessage = { role: 'assistant', content: assistantContent };
        this.messages.push(assistantMessage);
        const lastUsage = usageBox.value;
        if (lastUsage) {
          totalUsage.input_tokens += lastUsage.input_tokens;
          totalUsage.output_tokens += lastUsage.output_tokens;
          totalUsage.cache_creation_input_tokens =
            (totalUsage.cache_creation_input_tokens ?? 0) + (lastUsage.cache_creation_input_tokens ?? 0);
          totalUsage.cache_read_input_tokens =
            (totalUsage.cache_read_input_tokens ?? 0) + (lastUsage.cache_read_input_tokens ?? 0);
          const cached = lastUsage.cache_read_input_tokens ?? 0;
          const ratio = lastUsage.input_tokens > 0 ? Math.round((cached / lastUsage.input_tokens) * 100) : 0;
          const sLabel = this.opts.sessionId != null
            ? (this.isSubagent ? `${this.opts.sessionId}/sub` : String(this.opts.sessionId))
            : '?';
          const tag = `[coder s=${sLabel} r=${this.runId.slice(0, 8)}]`;
          console.log(
            `${tag} turn=${turn} input=${lastUsage.input_tokens} output=${lastUsage.output_tokens} cache_hit=${cached} ratio=${ratio}%`,
          );
          if (turn >= 3 && ratio < 40 && lastUsage.input_tokens > 5_000) {
            console.warn(
              `${tag} low cache hit rate (${ratio}%) at turn ${turn}. ` +
              `Check for prefix mutation: tools sort order, system prompt stability, push-time truncation.`,
            );
          }
        }
        this.emit('message_complete', assistantMessage, lastUsage);
        // Persist real input_tokens across turns so the next iteration's compaction
        // check can use actual token counts rather than character estimates.
        if (lastUsage?.input_tokens) {
          lastKnownInputTokens = lastUsage.input_tokens;
          // Capture the message count seen by the API so the hybrid token
          // snapshot can distinguish the confirmed prefix from the locally-
          // estimated tail in subsequent turns. Account for the assistant
          // message we're about to push (it was sent but isn't yet appended).
          lastUsageMessageCount = this.messages.length;
        }

        // Emit context metrics so the dashboard can show a progress indicator.
        const historyChars = totalChars(this.messages);
        this.emit('context_status', {
          history_chars: historyChars,
          turn,
          max_turns: this.maxTurns,
          auto_continue_count: autoContinueCount,
          auto_continue_max: MAX_AUTO_CONTINUES,
          last_turn_input_tokens: lastUsage?.input_tokens ?? 0,
          context_window: this.opts.context_window ?? getModelContextWindow(this.opts.provider.model ?? ''),
        });

        // Always emit `tool_batch` once per turn so observability dashboards
        // can count turns and see at a glance which turns ended with text-only
        // responses (count === 0) versus which dispatched tools.
        this.emit('tool_batch', {
          runId: this.runId,
          turn,
          count: toolUseBlocks.length,
          names: toolUseBlocks.map((b) => b.name),
        });

        // No tool calls → check if we should nudge or end.
        if (toolUseBlocks.length === 0) {
          // In plan mode: if the model wrote text mid-investigation without calling
          // a tool or submit_plan, inject ONE nudge so it can follow through.
          // Gated on turn > 1 so trivial greetings / one-shot answers don't get
          // a nudge — only sessions that were already doing tool work get one.
          const midInvestigation =
            this.opts.planMode &&
            !this.planApproved &&
            !this.tasksApproved &&
            turn > 1 &&
            !planNudgeSent;
          if (midInvestigation) {
            planNudgeSent = true;
            console.log(`[coder] plan mode: text-only turn ${turn} mid-investigation — injecting nudge`);
            this.messages.push({
              role: 'user',
              content: [{ type: 'text', text: '[System] Continue your investigation and call submit_plan when you have a complete proposal ready, or submit_tasks to begin execution.' }],
              isMeta: true,
            });
            continue;
          }

          // Agent Loop v2 stop-guard: if the model is stopping but the live
          // todo list still has unfinished items, push back ONCE with a
          // recap and let it continue. This is the most reliable place to
          // catch "agent forgot to mark items done before yielding". Hard
          // cap = 1 nudge per session; second attempt to stop completes
          // unconditionally so we never loop.
          if (
            this.opts.agentLoopV2 &&
            !this.agentLoopV2NudgeUsed &&
            this.hasUnfinishedTodos()
          ) {
            this.agentLoopV2NudgeUsed = true;
            const recap = this.buildStopGuardRecap();
            this.messages.push({ role: 'user', content: [{ type: 'text', text: recap }], isMeta: true });
            this.logSystemReminder('agent-loop-v2-stop-guard', recap);
            this.setTransition('stop-guard-nudge');
            this.emit('stop_nudged', { turn, recap });
            continue;
          }

          this.recentTurnSignatures.length = 0;
          this.recentTurnNamesSignatures.length = 0;
          this.recentTurnDominance.length = 0;
          // A completed text turn is exactly the signal we want — clear
          // the dup-call counter too so legitimate post-text resumption
          // doesn't inherit stale counters from a prior dead-end probe.
          this.toolCallFreq.clear();
          // Telemetry: text-only completion turn — no tools, no tool_results.
          this.lastTurnTelemetryId = this.persistTurnTelemetry({
            turn,
            lastUsage,
            toolUseBlocks,
            toolResultBlocks: [],
            historyChars,
            compactionTriggered: compactionTriggeredThisTurn,
            summarizerRan: summarizerRanThisTurn,
            systemPromptChars: this.opts.systemPrompt?.length ?? 0,
            toolsDefChars: JSON.stringify(tools).length,
          });
          // Hook: completion (session-scoped — suppress for subagents per PR-6 R24).
          if (!this.isSubagent) {
            await this.opts.hookRegistry?.fireCompletion({
              sessionId: 0, projectName: '', provider: this.opts.provider.name ?? 'unknown',
              model: this.opts.provider.model ?? 'unknown', turn,
              reason: 'completed', totalUsage, turnCount: turn,
            });
          }
          return this.finishWith(totalUsage, 'completed');
        }

        // Repeatable-tool exemption: if EVERY tool in this turn is a
        // declared polling tool, skip all three doom-loop guards. Polling
        // tools (wait_for_compile_clean, wait_agents, tail_*) intentionally
        // run repeatedly with identical args; flagging that as a stuck
        // loop would make basic await workflows unusable. We require ALL
        // blocks to be repeatable to be conservative — a turn that mixes
        // a poll with a regular tool still goes through the guards (the
        // regular tool ought to make progress and reset the streak).
        const turnAllRepeatable =
          toolUseBlocks.length > 0 &&
          toolUseBlocks.every((b) => {
            const def = this.opts.registry.get(b.name);
            return def?.repeatable === true || REPEATABLE_NAME_PATTERN.test(b.name);
          });

        // Doom-loop guard: if the model just asked for the exact same set of
        // tool calls N turns in a row, something is stuck. Refuse to execute
        // and bail with an error so the host can surface it to the user.
        const dlThresh = doomLoopThreshold();
        if (dlThresh >= 2 && !turnAllRepeatable) {
          const sig = toolCallsSignature(
            toolUseBlocks.map((b) => ({ name: b.name, input: b.input })),
          );
          this.recentTurnSignatures.push(sig);
          if (this.recentTurnSignatures.length > dlThresh) {
            this.recentTurnSignatures.shift();
          }
          if (
            this.recentTurnSignatures.length === dlThresh &&
            this.recentTurnSignatures.every((s) => s === sig && s !== '')
          ) {
            const err = new Error(
              `Doom loop detected: the same tool call${toolUseBlocks.length > 1 ? 's were' : ' was'} emitted ${dlThresh} turns in a row without progress. ` +
              `Last signature: ${sig.slice(0, 200)}${sig.length > 200 ? '…' : ''}. ` +
              `Aborting to avoid cost runaway — fix the underlying issue (wrong args, missing file, bad permission) before retrying.`,
            );
            console.warn(`[coder] doom-loop aborted at turn ${turn}: ${sig.slice(0, 120)}`);
            this.setTransition('doom-loop-strict');
            return this.finishWith(totalUsage, 'doom_loop', err);
          }
        }

        // Fuzzy doom-loop guard: catches "same tool names, tweaked args"
        // patterns the strict sig misses. Uses a higher threshold to keep
        // false-positive risk low on legitimate iterative workflows.
        if (DOOM_LOOP_FUZZY_THRESHOLD >= 2 && !turnAllRepeatable) {
          const loose = toolNamesSignature(toolUseBlocks.map((b) => ({ name: b.name })));
          this.recentTurnNamesSignatures.push(loose);
          if (this.recentTurnNamesSignatures.length > DOOM_LOOP_FUZZY_THRESHOLD) {
            this.recentTurnNamesSignatures.shift();
          }
          if (
            this.recentTurnNamesSignatures.length === DOOM_LOOP_FUZZY_THRESHOLD &&
            this.recentTurnNamesSignatures.every((s) => s === loose && s !== '')
          ) {
            const err = new Error(
              `Doom loop detected (fuzzy): the same tool set (${loose}) ran ${DOOM_LOOP_FUZZY_THRESHOLD} turns in a row with tweaked arguments and no progress. ` +
              `Aborting to avoid cost runaway — the model is likely retrying with minor variations instead of adjusting strategy.`,
            );
            console.warn(`[coder] fuzzy doom-loop aborted at turn ${turn}: ${loose.slice(0, 120)}`);
            this.setTransition('doom-loop-fuzzy');
            return this.finishWith(totalUsage, 'doom_loop', err);
          }
        }

        // Dominance guard (Fix G — session 609 regression). Even when the
        // strict/fuzzy guards don't fire, a session can sit in a single
        // tool name for many turns without ever producing assistant text.
        // Read 5 chunks rotating × 19 rounds = 95 turns, names sig stable
        // = `mcp__read_file`. The fuzzy guard SHOULD have caught that, but
        // some builds may have higher thresholds in env. This guard is the
        // last-line backstop: in a window of N turns, if a single tool
        // name dominates ≥80% AND zero turns produced text, abort.
        if (DOMINANCE_WINDOW >= 4 && !turnAllRepeatable) {
          const primaryName = toolUseBlocks[0]?.name ?? '';
          const hadText = pendingText.trim().length > 0;
          this.recentTurnDominance.push({ name: primaryName, hadText });
          if (this.recentTurnDominance.length > DOMINANCE_WINDOW) {
            this.recentTurnDominance.shift();
          }
          if (this.recentTurnDominance.length === DOMINANCE_WINDOW) {
            const counts = new Map<string, number>();
            let textTurns = 0;
            for (const e of this.recentTurnDominance) {
              counts.set(e.name, (counts.get(e.name) ?? 0) + 1);
              if (e.hadText) textTurns += 1;
            }
            let topName = '';
            let topCount = 0;
            for (const [n, c] of counts) {
              if (c > topCount) { topCount = c; topName = n; }
            }
            const ratio = topCount / DOMINANCE_WINDOW;
            if (ratio >= DOMINANCE_RATIO && textTurns === 0 && topName) {
              const err = new Error(
                `Stuck-loop detected (dominance): \`${topName}\` ran ${topCount}/${DOMINANCE_WINDOW} turns ` +
                `(${Math.round(ratio * 100)}%) with ZERO assistant text in between. ` +
                `The model is cycling through tool calls without reasoning — likely re-reading the same ` +
                `content variants. Aborting; the next user message can resume with a different prompt ` +
                `(e.g. ask for a finding/summary, or restrict scope).`,
              );
              console.warn(
                `[coder] dominance loop aborted at turn ${turn}: ${topName} ${topCount}/${DOMINANCE_WINDOW} no-text`,
              );
              this.setTransition('doom-loop-fuzzy');
              return this.finishWith(totalUsage, 'doom_loop', err);
            }
          }
        }

        // Execute each tool call sequentially and collect results.
        // (tool_batch was emitted before the doom-loop guards — see above.)
        const toolResultBlocks: ContentBlock[] = [];
        // Tools like `view_image` can inject extra user-visible content
        // (images, documents) the model needs to perceive. We collect those
        // here and push them as a synthetic user message after the tool
        // batch — providers then route them through their image-handling
        // path on the next turn.
        const extraUserBlocks: ContentBlock[] = [];
        for (const block of toolUseBlocks) {
          if (this.aborted) break;
          this.emit('tool_call_start', block.id, block.name, block.input);

          // PR-5 (Row 32) — pre-read enforcement, smarter variant.
          // When the same (path, slice) read has been issued recently, the
          // legacy guard refused outright. The smarter variant evaluates
          // four cases in this order before deciding:
          //
          //   1. MUTATION: if the path was written to since the prior read
          //      (edit_file / write_file / apply_patch / ...), the call is
          //      ALLOWED. The post-dispatch hook will replace the new
          //      tool_result with a unified diff vs. the prior content so
          //      the model gets the smallest possible payload that conveys
          //      "what changed". Resolves the codex-vs-doom-loop tension
          //      documented in docs/agent-research/COMPARISON.md.
          //
          //   2. ELIDE: if every prior tool_result for this slice is now
          //      a `[duplicate-read elided]` / `[compacted:` / `[stale:`
          //      placeholder, the content has LEFT the context window. The
          //      call is ALLOWED — refusing would be a lie ("already in
          //      your context") that blocks legitimate work.
          //
          //   3. AUTO-DOWNGRADE (opt-in, CODER_READ_AUTO_DOWNGRADE=1): the
          //      runner returns a skeleton-style summary instead of a hard
          //      refusal, marked `[auto-downgraded]`. Default off because
          //      hard refusal is pedagogically clearer.
          //
          //   4. RICH REFUSE: the default fall-through. The refusal now
          //      includes a pointer to the prior turn(s), the current mtime
          //      (so the model can tell whether the file moved), and a
          //      head+tail preview of what was read.
          //
          // All four paths emit a TransitionKind so telemetry distinguishes
          // them. Gated on agentLoopV2 — legacy sessions are untouched.
          if (this.opts.agentLoopV2 && REDUCIBLE_READ_TOOLS.has(block.name)) {
            const inp = block.input as Record<string, unknown> | undefined;
            const path = getStringField(inp, 'path', 'file_path');
            if (path) {
              const readKey = `${block.name}|${buildReadDedupKey(path, inp)}`;
              const threshold = readDupThreshold();
              const window = readDupWindow();
              const minTurn = turn - window;
              const prior = (this.recentReadKeys.get(readKey) ?? []).filter((e) => e.turn > minTurn);
              // Append the current call BEFORE the decision so the threshold
              // arithmetic matches the legacy behaviour (and the test for
              // window expiry still holds).
              prior.push({ turn, useId: block.id });
              this.recentReadKeys.set(readKey, prior);
              if (threshold >= 1 && prior.length >= threshold) {
                const oldestPrior = prior[0];
                // Layer 1: mutation since oldest prior read → ALLOW + diff.
                const mutationTurn = lastMutationTurn(
                  path,
                  this.recentWrites,
                  oldestPrior.turn,
                );
                if (mutationTurn != null) {
                  this.pendingDiffRereads.set(block.id, {
                    priorUseId: oldestPrior.useId,
                    priorTurn: oldestPrior.turn,
                    path,
                  });
                  this.setTransition('pre-read-allowed-mutation');
                  console.warn(
                    `[coder] pre-read allowed (mutation at turn ${mutationTurn}): ${block.name} for "${path}" — diff post-process queued`,
                  );
                  // Fall through to normal dispatch.
                } else if (allPriorReadsElided(prior.slice(0, -1), this.messages)) {
                  // Layer 2: prior result(s) elided/compacted → ALLOW fresh read.
                  this.setTransition('pre-read-allowed-elided');
                  console.warn(
                    `[coder] pre-read allowed (prior result elided): ${block.name} for "${path}" — re-fetching dropped content`,
                  );
                  // Fall through to normal dispatch.
                } else if (readAutoDowngradeEnabled()) {
                  // Layer 3: opt-in auto-downgrade — return a skeleton-like
                  // pointer instead of a hard refusal. Deterministic content.
                  const downgrade = buildAutoDowngradeResponse(
                    block.name,
                    path,
                    prior,
                    window,
                    this.messages,
                  );
                  const synth = buildToolResultBlock(
                    block.id,
                    downgrade,
                    /* is_error */ false,
                    this.effectivePushTimeCap,
                  );
                  toolResultBlocks.push(synth);
                  this.setTransition('pre-read-auto-downgraded');
                  console.warn(
                    `[coder] pre-read auto-downgraded: ${block.name} ${prior.length}× for "${path}" at turn ${turn}`,
                  );
                  this.emit('tool_call_result', block.id, block.name, {
                    content: downgrade,
                    isError: false,
                  }, 0);
                  continue; // skip dispatch
                } else {
                  // Layer 4: rich refusal — pointer + mtime + preview.
                  const firstPrior = prior.find((p) => p !== prior[prior.length - 1]) ?? prior[0];
                  const priorResult = findToolResultByUseId(firstPrior.useId, this.messages);
                  const preview = priorResult && !priorResult.isElided
                    ? extractReadPreview(priorResult.content)
                    : undefined;
                  let currentMtimeMs: number | undefined;
                  try {
                    const abs = pathResolve(this.opts.toolContext.cwd, path);
                    currentMtimeMs = fsStatSync(abs).mtimeMs;
                  } catch {
                    /* path may not exist anymore — leave undefined */
                  }
                  const refusal = buildRichRefusal({
                    toolName: block.name,
                    path,
                    prior: prior.slice(0, -1), // exclude current call
                    windowTurns: window,
                    currentMtimeMs,
                    contextPreview: preview,
                  });
                  const synth = buildToolResultBlock(
                    block.id,
                    refusal,
                    true,
                    this.effectivePushTimeCap,
                  );
                  toolResultBlocks.push(synth);
                  this.setTransition('pre-read-blocked');
                  console.warn(
                    `[coder] pre-read cap fired: ${block.name} ${prior.length}× for "${path}" — refused at turn ${turn}`,
                  );
                  this.emit('tool_call_result', block.id, block.name, {
                    content: refusal,
                    isError: true,
                  }, 0);
                  continue; // skip dispatch
                }
              }
            }
          }

          // Fix F — per-arg call-frequency cap. Compute a stable hash of the
          // (name, args) pair, prune entries that fell out of the rolling
          // window, append current turn. If the count exceeds the threshold,
          // refuse the call inline with a synthetic tool_result so the model
          // gets a clear "stop, change strategy" signal without the runner
          // having to abort the whole session. Catches the session 609
          // pattern (5 read_file slices rotated 19× each) that the
          // strict/fuzzy guards both miss.
          //
          // Repeatable polling tools (wait_for_compile_clean, wait_agents,
          // tail_logs, etc.) are exempt — their entire use case is to be
          // called repeatedly with identical args until external state
          // settles. Detection: explicit `toolDef.repeatable === true`
          // OR a name matching the polling convention (covers MCP external
          // tools whose author followed `wait_for_*` etc. without the loader
          // having auto-flagged them). REPEATABLE_NAME_PATTERN tolerates
          // the `ext_<server>__` prefix injected by mcp-server-manager.
          const repeatableToolDef = this.opts.registry.get(block.name);
          const isRepeatable =
            repeatableToolDef?.repeatable === true ||
            REPEATABLE_NAME_PATTERN.test(block.name);
          let argHash = '';
          try {
            argHash = createHash('sha1')
              .update(`${block.name}|${JSON.stringify(block.input ?? {})}`)
              .digest('hex');
          } catch {
            /* unhashable args (cyclic / native handle) — skip the cap */
          }
          if (argHash && DUP_CALL_THRESHOLD >= 2 && !isRepeatable) {
            const prior = this.toolCallFreq.get(argHash) ?? [];
            const minTurn = turn - DUP_CALL_WINDOW;
            const filtered = prior.filter((t) => t > minTurn);
            filtered.push(turn);
            this.toolCallFreq.set(argHash, filtered);
            if (filtered.length >= DUP_CALL_THRESHOLD) {
              const refusal =
                `Refused: \`${block.name}\` was called with these exact arguments ${filtered.length} ` +
                `times in the last ${DUP_CALL_WINDOW} turns. This is a redundant call — you already ` +
                `have the latest result earlier in this conversation. Change strategy: ` +
                `(a) write a finding/text response, (b) try a different tool ` +
                `(mcp__get_file_skeleton, mcp__find_references, mcp__search), or ` +
                `(c) edit the code instead of re-reading. Repeating this call will not produce new info.`;
              const synth = buildToolResultBlock(
                block.id,
                refusal,
                true,
                this.effectivePushTimeCap,
              );
              toolResultBlocks.push(synth);
              console.warn(
                `[coder] dup-call cap fired: ${block.name} ${filtered.length}× in window — refused at turn ${turn}`,
              );
              this.emit('tool_call_result', block.id, block.name, {
                content: refusal,
                isError: true,
              }, 0);
              continue; // skip the dispatch below
            }
          }

          // Hook: before tool call
          await this.opts.hookRegistry?.fireToolCall({
            sessionId: 0, projectName: '', provider: this.opts.provider.name ?? 'unknown',
            model: this.opts.provider.model ?? 'unknown', turn,
            toolName: block.name, toolArgs: block.input, phase: 'before',
          });
          const start = Date.now();
          let result;
          // Look up the tool definition so the policy module can read its
          // metadata. `registry.get` returns undefined for unknown names —
          // the registry's own `invoke` falls back to an Unknown-tool error
          // which we surface to the model as a normal tool result.
          const toolDef = this.opts.registry.get(block.name);
          if (!toolDef) {
            result = await this.opts.registry.invoke(block.name, block.input, this.opts.toolContext);
          } else {
            const policyCtx: PolicyContext = {
              planMode: !!this.opts.planMode,
              planApproved: this.planApproved,
              taskScope: this.currentTaskScope
                ? { id: this.currentTaskScope.id, files: [...this.currentTaskScope.files] }
                : null,
              // Phase 5 reserved — runner stays in legacy mode for now.
              strict: false,
              adminOverride: this.opts.adminOverride ?? true,
              sandboxBound:
                !!this.opts.toolContext.ports?.fs || !!this.opts.toolContext.ports?.shell,
            };
            const decision = evaluateToolInvocation(toolDef, block.input, policyCtx);

            // Confirm-before-irreversible gate (Camada B). Active when the
            // session's agent opted in (only `admin` today). The first time
            // the LLM tries an irreversible call we refuse and instruct it
            // to call `ask_user`; on the next attempt with the same args
            // we interpret it as "user approved, retry" and let it through.
            //
            // We DELIBERATELY do not gate on policy.allowed first: a tool
            // can be policy-allowed (admin mode, no plan gate) and still
            // need user confirmation. The two gates are independent.
            const agentDef = this.opts.agentId ? AGENTS[this.opts.agentId] : null;
            const needsConfirmGate =
              decision.allowed
              && agentDef?.confirmBeforeIrreversible === true
              && isIrreversibleTool(block.name);
            let confirmHash = '';
            if (needsConfirmGate) {
              try {
                confirmHash = createHash('sha1')
                  .update(`${block.name}|${JSON.stringify(block.input ?? {})}`)
                  .digest('hex');
              } catch {
                /* unhashable args → fall back to name-only key */
                confirmHash = `name:${block.name}`;
              }
            }
            if (needsConfirmGate && !this.pendingConfirms.has(confirmHash)) {
              this.pendingConfirms.add(confirmHash);
              const previewArgs = JSON.stringify(block.input ?? {});
              const preview = previewArgs.length > 200
                ? previewArgs.slice(0, 200) + '...'
                : previewArgs;
              const message =
                `Refused: \`${block.name}\` is an irreversible operation and admin mode requires explicit user confirmation before running it.\n\n` +
                `Args preview: \`${preview}\`\n\n` +
                `What to do:\n` +
                `1. Call \`ask_user\` with options=["Yes","No"] and a one-line summary of what this will do.\n` +
                `2. If the user answers Yes, retry the EXACT same \`${block.name}\` call with the same arguments — the runner will let it through on the second attempt.\n` +
                `3. If the user answers No, abort and report.`;
              this.emit('blocked', {
                runId: this.runId,
                turn,
                tool: block.name,
                reason: 'admin_required',
                detail: 'irreversible operation — awaiting user confirmation via ask_user',
              });
              result = { content: message, isError: true };
            } else if (decision.allowed) {
              // Either the gate is off, or this is the retry — drop the
              // pending-confirm marker so a third attempt would re-prompt.
              if (confirmHash) this.pendingConfirms.delete(confirmHash);
              result = await this.opts.registry.invoke(block.name, block.input, this.opts.toolContext);
            } else if (
              decision.reason === 'plan_mode'
              && decision.metadata.scopeAware
              && policyCtx.taskScope
            ) {
              // Inline task-scope unlock: mutating tools may still run for
              // paths declared in the active task's `files`. Anything outside
              // is blocked — preserves the legacy contract.
              const scopeFiles = policyCtx.taskScope.files;
              const candidatePaths = extractPathsFromToolArgs(block.name, block.input);
              const violators = findScopeViolations(candidatePaths, scopeFiles, isPathInsideScope);
              const allInside = candidatePaths.length > 0 && violators.length === 0;
              if (allInside) {
                result = await this.opts.registry.invoke(block.name, block.input, this.opts.toolContext);
              } else {
                this.emit('blocked', {
                  runId: this.runId,
                  turn,
                  tool: block.name,
                  reason: 'task_scope',
                  detail: `paths outside scope: ${violators.join(', ')}`,
                });
                result = {
                  content: `Tool '${block.name}' refused: path(s) outside the current task scope. ` +
                    `Task ${policyCtx.taskScope.id} declared files=[${scopeFiles.join(', ')}]; ` +
                    `tried to touch [${violators.join(', ')}]. ` +
                    `Either edit a file inside the declared scope, or call task_complete and submit a new task.`,
                  isError: true,
                };
              }
            } else {
              this.emit('blocked', {
                runId: this.runId,
                turn,
                tool: block.name,
                reason: decision.reason,
                detail: decision.detail,
              });
              result = { content: decision.detail, isError: true };
            }
          }
          const durationMs = Date.now() - start;
          // Accumulate subagent usage into the parent's total — costs of work
          // delegated to a subagent must NEVER be hidden from the session.
          if (result.subUsage) {
            totalUsage.input_tokens += result.subUsage.input_tokens;
            totalUsage.output_tokens += result.subUsage.output_tokens;
            totalUsage.cache_creation_input_tokens =
              (totalUsage.cache_creation_input_tokens ?? 0) + (result.subUsage.cache_creation_input_tokens ?? 0);
            totalUsage.cache_read_input_tokens =
              (totalUsage.cache_read_input_tokens ?? 0) + (result.subUsage.cache_read_input_tokens ?? 0);
            const subCached = result.subUsage.cache_read_input_tokens ?? 0;
            console.log(
              `[coder] subagent tool=${block.name} input=${result.subUsage.input_tokens} output=${result.subUsage.output_tokens} cache_hit=${subCached}`,
            );
          }
          this.emit('tool_call_result', block.id, block.name, result, durationMs);
          // Hook: after tool call
          await this.opts.hookRegistry?.fireToolCall({
            sessionId: 0, projectName: '', provider: this.opts.provider.name ?? 'unknown',
            model: this.opts.provider.model ?? 'unknown', turn,
            toolName: block.name, toolArgs: block.input, phase: 'after',
            result, durationMs,
          });
          // Side-file truncation: if the content is too large AND the runner
          // has a tool output store wired in, persist the full content and
          // include the output_id in the truncation marker. This lets the
          // agent retrieve the elided portion via `get_tool_output(id)` on
          // demand — without making every large output permanently visible.
          const cap = this.effectivePushTimeCap;
          let persistedId: string | null = null;
          if (result.content.length > cap && this.opts.toolContext.toolOutputStore) {
            // Persist the RAW content so get_tool_output can return everything;
            // the reducer below only shapes what goes into the prompt.
            persistedId = this.opts.toolContext.toolOutputStore.put(result.content);
          }
          // Smart reducer (B4): tool-aware truncation that preserves the
          // most useful slices for git_log/git_diff/grep/run_command before
          // the generic head-cut kicks in. Determinism is part of the
          // contract — same input → same output, so prefix cache stays stable.
          let shapedContent = applySmartReducer(block.name, result.content, cap);
          let shapedIsError = result.isError;

          // Agent Loop v2: post-result content dedup. Hash the RAW result and
          // refuse on the second identical content for the same tool within
          // RESULT_DUP_WINDOW turns. Catches arg-shift loops the strict and
          // arg-hash guards miss (e.g. around_line=1640 vs 1690 both snap to
          // lines 1673-1685 — same content, different arg hash).
          //
          // Repeatable polling tools are exempt (same rationale as the
          // pre-call cap): identical content across calls is the steady-
          // state signal ("compile still clean", "agents still running"),
          // not a stuck-loop artifact. `isRepeatable` was computed before
          // the dispatch above and is still in scope here.
          if (
            this.opts.agentLoopV2 &&
            !result.isError &&
            !isRepeatable &&
            typeof result.content === 'string' &&
            result.content.length >= RESULT_DUP_MIN_CHARS
          ) {
            const resultHash = createHash('sha1').update(result.content).digest('hex');
            const prior = this.recentResultHashes.get(block.name) ?? [];
            const minTurn = turn - RESULT_DUP_WINDOW;
            const filtered = prior.filter((e) => e.turn > minTurn);
            const matches = filtered.filter((e) => e.hash === resultHash).length;
            filtered.push({ hash: resultHash, turn });
            // Cap entries per tool to keep the map small.
            while (filtered.length > RESULT_DUP_WINDOW * 2) filtered.shift();
            this.recentResultHashes.set(block.name, filtered);
            if (matches >= RESULT_DUP_THRESHOLD) {
              const refusal =
                `Refused: \`${block.name}\` returned the IDENTICAL content (${result.content.length} chars) ` +
                `that you already received earlier in this conversation (seen ${matches} time${matches === 1 ? '' : 's'} ` +
                `in the last ${RESULT_DUP_WINDOW} turns). The slice resolver mapped your args to the same body ` +
                `as a previous call. Stop re-reading and change strategy: ` +
                `(a) quote the content from the earlier read, ` +
                `(b) request a DIFFERENT region (use start_line/end_line or a different symbol), ` +
                `(c) try a different tool (mcp__get_file_skeleton, mcp__find_references, mcp__search), or ` +
                `(d) make the edit you came here to make.`;
              shapedContent = refusal;
              shapedIsError = true;
              console.warn(
                `[coder] result-dup-cap fired: ${block.name} returned same hash ${matches}× — refused at turn ${turn}`,
              );
              this.emit('tool_call_result', block.id, block.name, {
                content: refusal,
                isError: true,
              }, 0);
            }
          }

          // Smarter pre-read enforcement — post-dispatch follow-up.
          //
          //   (a) Read-tools: stamp the most-recent recentReadKeys entry with
          //       contentHash and current mtime so future guard decisions
          //       can short-circuit on "file unchanged since prior read".
          //   (b) pendingDiffRereads: if the guard ALLOWED this call via
          //       the mutation branch, replace shapedContent with a unified
          //       diff against the prior read (or annotate when the prior
          //       result has been compacted out of context).
          //   (c) Mutating tools: stamp recentWrites[path] = turn so the
          //       guard can detect re-reads of paths the model just changed.
          if (this.opts.agentLoopV2 && !result.isError && REDUCIBLE_READ_TOOLS.has(block.name)) {
            const inp = block.input as Record<string, unknown> | undefined;
            const path = getStringField(inp, 'path', 'file_path');
            if (path) {
              const readKey = `${block.name}|${buildReadDedupKey(path, inp)}`;
              const list = this.recentReadKeys.get(readKey);
              if (list && list.length > 0) {
                const tail = list[list.length - 1];
                if (tail.useId === block.id) {
                  if (typeof result.content === 'string') {
                    tail.contentHash = createHash('sha1').update(result.content).digest('hex');
                  }
                  try {
                    tail.mtimeMs = fsStatSync(pathResolve(this.opts.toolContext.cwd, path)).mtimeMs;
                  } catch { /* file may not exist */ }
                }
              }
            }
            const pending = this.pendingDiffRereads.get(block.id);
            if (pending && typeof result.content === 'string') {
              this.pendingDiffRereads.delete(block.id);
              const priorResult = findToolResultByUseId(pending.priorUseId, this.messages);
              if (priorResult && !priorResult.isElided) {
                const diff = buildSimpleLineDiff(priorResult.content, result.content, 3);
                shapedContent =
                  `[reread-after-edit] \`${pending.path}\` was mutated since your prior read at turn ${pending.priorTurn}. ` +
                  `Returning unified diff against that read (pass force=true to bypass diff and get full content).\n\n` +
                  diff;
              } else {
                shapedContent =
                  `[reread-after-edit] \`${pending.path}\` was mutated since your prior read at turn ${pending.priorTurn}, ` +
                  `but that prior read has been compacted from your context. Returning full current content below.\n\n` +
                  shapedContent;
              }
            }
          }
          // Mutation tracker — update AFTER successful dispatch only.
          if (this.opts.agentLoopV2 && !result.isError && isMutatingFsTool(block.name)) {
            const inp = block.input as Record<string, unknown> | undefined;
            if (block.name === 'apply_patch') {
              // apply_patch touches many paths — scan the patch text for the
              // header lines that name the files. The patch already applied
              // successfully, so the names there reflect actual writes.
              const raw =
                typeof inp?.['patch'] === 'string' ? (inp['patch'] as string) :
                typeof inp?.['_raw'] === 'string' ? (inp['_raw'] as string) : '';
              for (const m of raw.matchAll(/\*\*\* (?:Update|Add|Delete) File:\s*(.+)$/gm)) {
                this.recentWrites.set(m[1].trim(), turn);
              }
            } else {
              const path = getStringField(inp, 'path', 'file_path');
              if (path) this.recentWrites.set(path, turn);
            }
          }

          toolResultBlocks.push(
            buildToolResultBlock(block.id, shapedContent, shapedIsError, cap, persistedId ?? undefined),
          );
          if (result.extraUserBlocks && result.extraUserBlocks.length > 0) {
            extraUserBlocks.push(...result.extraUserBlocks);
          }
        }

        this.messages.push({ role: 'tool', content: toolResultBlocks });
        // Telemetry: tool-emitting turn. Capture AFTER tool execution so
        // largest_tool_result_chars and paginate_count reflect what actually
        // happened.
        this.lastTurnTelemetryId = this.persistTurnTelemetry({
          turn,
          lastUsage,
          toolUseBlocks,
          toolResultBlocks,
          historyChars,
          compactionTriggered: compactionTriggeredThisTurn,
          summarizerRan: summarizerRanThisTurn,
          systemPromptChars: this.opts.systemPrompt?.length ?? 0,
          toolsDefChars: JSON.stringify(tools).length,
        });
        if (extraUserBlocks.length > 0) {
          // Append as a separate user message — providers expect tool results
          // and human content in distinct messages. The text preface keeps the
          // transcript readable when the user reopens the session.
          this.messages.push({
            role: 'user',
            content: [
              { type: 'text', text: '[tool-injected content]' },
              ...extraUserBlocks,
            ],
          });
        }
      } // end inner while (turn < maxTurns)

      // If aborted during the inner loop, don't auto-continue.
      if (this.aborted) {
        return this.finishWith(totalUsage, 'aborted');
      }

      // Auto-continue: instead of dying at maxTurns, reset the turn counter and
      // (only if context is full) compact history. Mirrors Claude Code's behaviour —
      // the agent only stops when there's no more work, not due to an artificial ceiling.
      //
      // New path: model-decision driven. We continue as long as we haven't
      // exceeded a generous safety cap (MAX_AUTO_CONTINUES env, default 3 in
      // legacy mode; bumped to 8 in token-mode where the model can self-bound).
      // Hard floor of 0 disables auto-continue entirely.
      const autoContinueCap = tokenLimits ? Math.max(MAX_AUTO_CONTINUES, 8) : MAX_AUTO_CONTINUES;
      if (autoContinueCap > 0 && autoContinueCount < autoContinueCap) {
        autoContinueCount++;
        this.emit('auto_continue', autoContinueCount, autoContinueCap);

        // Skip compaction when context is well below the trigger. Auto-continue
        // exists to extend beyond maxTurns; it is NOT a signal that we're out of
        // tokens. When there's no real pressure, just reset state and continue —
        // the dashboard then shows "Auto-continuing..." without a misleading
        // "Context compacted" message.
        const needsCompaction = tokenLimits
          ? computeTokenSnapshot().total >= tokenLimits.trigger
          : (compactionLimits.triggerTokens !== null && lastKnownInputTokens !== null
              ? lastKnownInputTokens >= compactionLimits.triggerTokens
              : totalChars(this.messages) > compactionLimits.minimum);

        if (!needsCompaction) {
          if (tokenLimits) {
            const snap = computeTokenSnapshot();
            console.log(
              `[coder] auto-continue ${autoContinueCount}/${autoContinueCap} — ` +
              `context OK (${snap.total}/${tokenLimits.trigger} tokens, ${snap.source}), skipping compaction`,
            );
          } else {
            console.log(
              `[coder] auto-continue ${autoContinueCount}/${autoContinueCap} — ` +
              `context OK (${lastKnownInputTokens ?? '?'}/${compactionLimits.triggerTokens ?? '?'} tokens), skipping compaction`,
            );
          }
          this.summarizedOnce = false;
          lastKnownInputTokens = null;
          lastUsageMessageCount = 0;
          turn = 0;
          if (this.opts.isCompanySubordinate) {
            this.messages.push({ role: 'user', content: [{ type: 'text', text: SUBORDINATE_REMINDER_MSG }], isMeta: true });
            this.logSystemReminder('subordinate-deliverable-autocontinue', SUBORDINATE_REMINDER_MSG);
            if (this.opts.companyRoleOverride) {
              const text = `[System reminder — Role identity] ${this.opts.companyRoleOverride}`;
              this.messages.push({ role: 'user', content: [{ type: 'text', text }], isMeta: true });
              this.logSystemReminder('role-identity-autocontinue', text);
            }
          }
          // Agent Loop v2 recap: also surface a goal/todos/active-task summary
          // on auto-continue for ANY session, not just subordinates. The
          // <active-context> per-turn injection covers the live snapshot, but
          // an explicit reminder at the auto-continue boundary helps the model
          // re-anchor after a 50-turn span.
          if (this.opts.agentLoopV2) {
            const recap = this.buildAutoContinueRecap();
            if (recap) {
              this.messages.push({ role: 'user', content: [{ type: 'text', text: recap }], isMeta: true });
              this.logSystemReminder('agent-loop-v2-autocontinue', recap);
            }
          }
          continue;
        }

        console.log(
          `[coder] auto-continue ${autoContinueCount}/${autoContinueCap} — compacting history before resuming`,
        );

        // Summarize the old span for richer context preservation, falling
        // back to deterministic compaction if the summarizer is unavailable.
        const histTotal = totalChars(this.messages);
        const rawCutoff2 = tokenLimits
          ? computeCutoffIndexByTokens(this.messages, tokenLimits.protect)
          : computeCutoffIndex(this.messages, compactionLimits.protect);
        // PR-3 (R4): preserve last N user turns raw — see the same call
        // in the pre-turn compaction site above.
        const recededCutoff2 = this.opts.agentLoopV2
          ? recedeToPreserveLastNTurns(this.messages, rawCutoff2, preserveLastNTurns())
          : rawCutoff2;
        const cutoff = tokenLimits
          ? snapCutoffPreservingPairs(this.messages, recededCutoff2)
          : snapCutoffToRoleBoundary(this.messages, recededCutoff2);
        let strategy: 'summarizer' | 'deterministic' | 'none' = 'none';
        let prunedMessages = 0;
        let prunedChars = 0;
        if (cutoff > 1) {
          const span = this.messages.slice(0, cutoff);
          let replaced = false;
          try {
            const summaryRaw = isStructuredSummaryEnabled()
              ? await summarizeSpanV2(span, this.opts.provider)
              : await summarizeSpan(span, this.opts.provider);
            const summary = this.opts.agentLoopV2 && summaryRaw && 'primary_request' in summaryRaw
              ? overlayLiveState(
                  summaryRaw,
                  this.currentTodos,
                  this.opts.toolContext.getGoalState
                    ? (() => {
                        const g = this.opts.toolContext.getGoalState!();
                        return g ? { text: g.text, status: g.status } : null;
                      })()
                    : null,
                )
              : summaryRaw;
            if (summary) {
              const rendered = 'primary_request' in summary
                ? renderSummaryV2(summary)
                : renderSummary(summary);
              const synthetic: AgentMessage = {
                role: 'assistant',
                content: [{ type: 'text', text: rendered }],
              };
              this.messages.splice(0, cutoff, synthetic);
              if (tokenLimits) {
                const cleaned = postCompactCleanup(this.messages);
                if (cleaned.elidedReads > 0) {
                  this.messages.length = 0;
                  this.messages.push(...cleaned.messages);
                  console.log(`[coder] post-compact dedup elided ${cleaned.elidedReads} read(s) (~${cleaned.freedChars} chars freed)`);
                }
              }
              replaced = true;
              strategy = 'summarizer';
              prunedMessages = cutoff - 1; // cutoff original msgs replaced by 1 synthetic
              prunedChars = histTotal - totalChars(this.messages);
              consecutiveCompactFailures = 0;
              console.log(
                `[coder] summarizer collapsed ${cutoff} messages (~${histTotal} chars) into 1 synthetic summary`,
              );
            }
          } catch (e) {
            console.warn(`[coder] summarizer failed during auto-continue: ${e instanceof Error ? e.message : String(e)}`);
          }
          if (!replaced) {
            const compacted = tokenLimits
              ? compactMessages(this.messages, { protectTokens: tokenLimits.protect, skipMinimumGuard: true })
              : compactMessages(this.messages, { minimum: compactionLimits.minimum, protect: compactionLimits.protect });
            if (compacted.applied) {
              // compactMessages returns a new array — swap in-place.
              this.messages.length = 0;
              this.messages.push(...compacted.messages);
              strategy = 'deterministic';
              prunedMessages = compacted.prunedBlocks;
              prunedChars = compacted.prunedChars;
              console.log(
                `[coder] deterministic compaction pruned ${compacted.prunedBlocks} blocks (~${compacted.prunedChars} chars)`,
              );
            }
          }
        }
        this.emit('history_compacted', {
          strategy,
          pruned_messages: prunedMessages,
          pruned_chars: prunedChars,
          total_chars_before: histTotal,
          total_chars_after: totalChars(this.messages),
          auto_continue: autoContinueCount,
        });
        if (strategy === 'none') {
          consecutiveCompactFailures++;
          console.warn(`[coder] auto-continue compaction made no progress (failures=${consecutiveCompactFailures})`);
          if (consecutiveCompactFailures >= MAX_CONSECUTIVE_COMPACT_FAILURES) {
            console.error(`[coder] giving up after ${consecutiveCompactFailures} consecutive compaction failures`);
            this.emit('recovery_aborted', {
              kind: 'compact-failure',
              attempts: consecutiveCompactFailures,
              cap: MAX_CONSECUTIVE_COMPACT_FAILURES,
              contextHint: 'auto-continue-no-progress',
            });
            this.setTransition('compact-auto-continue');
            return this.finishWith(totalUsage, 'compact_failure');
          }
        }
        // Allow the summarizer to run again in the next continuation window.
        this.summarizedOnce = false;
        // Reset token baseline so the next window re-evaluates compaction from scratch.
        lastKnownInputTokens = null;
        lastUsageMessageCount = 0;
        // After compaction, re-inject the deliverable reminder for subordinates so
        // the instruction survives context suppression regardless of what was pruned.
        if (this.opts.isCompanySubordinate) {
          this.messages.push({ role: 'user', content: [{ type: 'text', text: SUBORDINATE_REMINDER_MSG }], isMeta: true });
          this.logSystemReminder('subordinate-deliverable-postcompact', SUBORDINATE_REMINDER_MSG);
          if (this.opts.companyRoleOverride) {
            const text = `[System reminder — Role identity] ${this.opts.companyRoleOverride}`;
            this.messages.push({ role: 'user', content: [{ type: 'text', text }], isMeta: true });
            this.logSystemReminder('role-identity-postcompact', text);
          }
        }
        // Reset turn counter so the inner while gets a full maxTurns budget.
        turn = 0;
        continue; // → back to outer while(true)
      }

      // Exhausted all auto-continues — stop for real.
      break;
    } // end outer while(true)

    return this.finishWith(totalUsage, 'max_turns');
  }

  private handleDelta(
    delta: ChatDelta,
    handlers: {
      onText: (t: string) => void;
      onThinking: (t: string) => void;
      onToolCall: (id: string, name: string, input: Record<string, unknown>) => void;
      onUsage: (u: ChatUsage) => void;
      onResponseId: (id: string, messageCount: number) => void;
      onImageGenerated: (mediaType: string, base64: string) => void;
    }
  ): void {
    switch (delta.type) {
      case 'text_delta':
        handlers.onText(delta.text);
        break;
      case 'thinking_delta':
        handlers.onThinking(delta.text);
        break;
      case 'tool_call_end':
        handlers.onToolCall(delta.id, delta.name, delta.input);
        break;
      case 'usage':
        handlers.onUsage(delta.usage);
        break;
      case 'response_id':
        handlers.onResponseId(delta.id, delta.messageCount);
        break;
      case 'image_generated':
        handlers.onImageGenerated(delta.mediaType, delta.base64);
        break;
      // tool_call_start, tool_call_args, done are informational only
      default:
        break;
    }
  }
}

// ─── Path scope helpers (used by inline task scope gate) ───────

/**
 * Best-effort extraction of filesystem paths from tool arguments. We don't
 * know every tool's schema, so we look for the most common shapes used by
 * fs/shell tools in this codebase: path, file_path, paths, cwd, target, and
 * the `command` string from run_command. Anything we extract is normalized
 * to a project-relative POSIX path; tokens we can't classify are skipped.
 */
export function extractPathsFromToolArgs(toolName: string, args: Record<string, unknown>): string[] {
  const out = new Set<string>();
  const push = (v: unknown) => {
    if (typeof v === 'string' && v.trim()) out.add(v.trim());
  };

  push((args as { path?: unknown }).path);
  push((args as { file_path?: unknown }).file_path);
  push((args as { target?: unknown }).target);
  push((args as { destination?: unknown }).destination);
  const paths = (args as { paths?: unknown }).paths;
  if (Array.isArray(paths)) for (const p of paths) push(p);

  // run_command: parse the command string for `cd <path>` and absolute paths.
  if (toolName === 'run_command' && typeof (args as { command?: unknown }).command === 'string') {
    const cmd = (args as { command: string }).command;
    // cd <path>
    const cdMatch = cmd.match(/(?:^|\s)cd\s+([^\s;|&]+)/);
    if (cdMatch) push(cdMatch[1]);
    // Absolute paths (POSIX or Windows) — flag for sandbox awareness.
    const absMatches = cmd.match(/(?:^|\s)([\\/][^\s;|&]+|[A-Za-z]:[\\/][^\s;|&]+)/g);
    if (absMatches) for (const m of absMatches) push(m.trim());
    // Tokens with .. for traversal
    const dotDot = cmd.match(/\S*\.\.\S*/g);
    if (dotDot) for (const m of dotDot) push(m);
  }

  return Array.from(out);
}

/**
 * True iff `candidate` resolves into one of `scopeFiles` (path-prefix match
 * after normalizing both to project-relative POSIX form). Conservative: if
 * normalization fails, treat as outside the scope.
 *
 * `scopeFiles` may contain individual files OR directories — both work.
 */
export function isPathInsideScope(candidate: string, scopeFiles: string[]): boolean {
  // Reject obvious traversal and absolute paths up front. Mid-task, the
  // model should be operating on the declared files only.
  if (candidate.includes('..')) return false;
  if (isAbsolute(candidate)) return false;
  // POSIX-normalize backslashes for cross-platform comparison.
  const norm = candidate.replace(/\\/g, '/');
  for (const scope of scopeFiles) {
    const s = scope.replace(/\\/g, '/');
    if (norm === s) return true;
    // Directory scope: candidate must be inside it.
    if (norm.startsWith(s.endsWith('/') ? s : s + '/')) return true;
  }
  return false;
}
// suppress unused-import warning until other helpers reference these
void pathResolve;
void pathRelative;
