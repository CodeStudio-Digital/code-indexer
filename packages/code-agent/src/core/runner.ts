import { EventEmitter } from 'node:events';
import { randomUUID, createHash } from 'node:crypto';
import { resolve as pathResolve, relative as pathRelative, isAbsolute } from 'node:path';
import { statSync as fsStatSync } from 'node:fs';
import type { ChatProvider } from '@mcp/code-agent/providers/adapter.js';
import type { ToolRegistry } from '@mcp/code-agent/core/registry.js';
import type {
  AgentMessage,
  ChatDelta,
  ChatProviderResponseMeta,
  ChatUsage,
  ContentBlock,
  ToolUseBlock,
  PlanBlock,
  SpecBlock,
  QuestionBlock,
  ToolResultBlock,
} from '@mcp/code-agent/core/messages.js';
import type { ToolContext } from '@mcp/code-agent/core/tool.js';
import { resolveHeartbeatIntervalMs, resolveToolTimeoutMs } from '@mcp/code-agent/core/tool-timeouts.js';
// Post-legacy-removal: only the helpers still consumed by
// `compactHistoryForLLM` (re-exported below) and the BT bridge
// (`enforcePreReadForBridge`, `postProcessToolResultForBridge`) remain.
// The char-based compaction, sliding-window, deriveCompactionLimits,
// isNewCompactionEnabled, postCompactCleanup, cutoff helpers — all
// dead, all dropped from the import surface.
import {
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
} from "@mcp/code-agent/core/compaction.js";
import {
  evaluateSoftAgentDecisionGuardrail,
  evaluateToolInvocation,
  findScopeViolations,
  isIrreversibleTool,
  isPlanModeWorkflowTool,
  type PolicyContext,
} from '@mcp/code-agent/core/policy.js';
import { type CoderTunables, envTunables } from '@mcp/code-agent/core/tunables.js';
import { repairToolPairing } from '@mcp/code-agent/core/transcript-repair.js';
import { AGENTS } from '@mcp/code-agent/agents/index.js';
import { isSummarizerEnabled, summarizeSpan, summarizeSpanV2, renderSummary, renderSummaryV2, isStructuredSummaryEnabled, overlayLiveState } from '@mcp/code-agent/core/summarizer.js';
import { computeSnapshot, type TokenSnapshot } from '@mcp/code-agent/core/token-accounting.js';
import { filterByTiers, profileToTiers, PREVIEW_TOOLS, type ToolTier, type CoderProfile } from '@mcp/code-agent/tools/tiers.js';
import { getSubagentJobManager } from '@mcp/code-agent/tools/subagent-jobs.js';
import { parkForBackgroundWork } from '@mcp/code-agent/tools/subagent-jobs-lifecycle.js';
import { terseDescription } from '@mcp/code-agent/tools/descriptions.js';
import { applySmartReducer } from '@mcp/code-agent/core/smart-reducers.js';
import { getModelContextWindow, getModelMaxTools, getEffectiveContextWindow } from '@mcp/code-agent/providers/capabilities.js';
import { runToolFilterHook } from '@mcp/code-agent/core/hooks.js';
import { resolveTemperature } from '@mcp/code-agent/inference/temperature.js';
import { estimateCost } from '@mcp/code-agent/providers/pricing-cache.js';
import { buildActiveContextBlock } from '@mcp/code-agent/core/active-context.js';
import {
  type TodoItem,
  buildTrackState,
  deriveTodosFromState,
} from '@mcp/code-agent/tools/task-list-shared.js';
import { buildIndexedDocsBlock } from '@mcp/code-agent/core/docs-hint.js';
import { interpolateSkillVars } from '@mcp/code-agent/skills/prompt-injector.js';
import type { SkillTemplateContext } from '@mcp/code-agent/skills/types.js';
import { getGlobalToolSelectionOutcomeObserver } from '@mcp/code-agent/tool-selection/global-filter.js';
import {
  isGlobalQualityClassifierEnabled,
  runGlobalQualityClassifiers,
  getGlobalQualityClassificationStore,
  getGlobalQualityInterventionStore,
  getGlobalQualityWatchdog,
  buildQualityNudge,
  detectToolMisuseStreak,
  getGlobalPolicyEnforcer,
  shouldClassifyTurn,
  worstVerdictOf,
  fnv1aSample,
} from '@mcp/services/quality/index.js';
import type { QualityResult } from '@mcp/services/quality/index.js';
import type { QualityClassificationRow } from '@mcp/store/quality-classification-store.js';
import type { InterventionVerdictSnapshot } from '@mcp/store/quality-intervention-store.js';
import {
  isGlobalContextRelevanceEnabled,
  tryGlobalContextCompact,
} from '@mcp/code-agent/context-relevance/index.js';

// Public types extracted to './runner/types.ts' (W4.2 split — keep this
// file under 250 LOC ceiling). Re-exported below so external consumers
// (`from './runner.js'`) keep their import paths unchanged.
import type {
  RunResult,
  RunnerOptions,
  StopReason,
  TransitionKind,
} from './runner/types.js';
export type { RunResult, RunnerOptions, StopReason, TransitionKind };

// (RunnerOptions body moved to './runner/types.ts'.)

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
// (Tunable constants — UNRESTRICTED_PUSH_TIME_CAP / UNRESTRICTED_SUBAGENT_PUSH_TIME_CAP /
// TURN_BUDGET_CHARS / DOOM_LOOP_FUZZY_THRESHOLD / DEBUG_DOOM_LOOP / DUP_CALL_* /
// REPEATABLE_NAME_PATTERN / RESULT_DUP_* / REPEATABLE_*_CAP / POLLING_STUCK_* /
// DUP_CALL_REMINDER_THRESHOLD / SUMMARIZER_* / RESULT_DUP_LARGE_THRESHOLD /
// RESULT_DUP_HEAD_CHARS / canRunSummarizer — all moved to './runner/constants.ts'.)
// Post-legacy-removal: only constants actively consumed by the BT
// bridge / `buildToolResultBlock` / re-exports survive. The dup-call,
// dup-result, REPEATABLE_*, DOOM_LOOP_FUZZY_THRESHOLD, DEBUG_DOOM_LOOP,
// TURN_BUDGET_CHARS, RESULT_DUP_* knobs were exclusive to the legacy
// while-loop's inline guards and have no remaining caller in this file.
import {
  UNRESTRICTED_PUSH_TIME_CAP,
  UNRESTRICTED_SUBAGENT_PUSH_TIME_CAP,
  REPEATABLE_NAME_PATTERN,
  POLLING_STUCK_CAP,
  POLLING_STUCK_MIN_CHARS,
  canRunSummarizer,
} from './runner/constants.js';
export { canRunSummarizer };

// (Wire #2 tool-misuse intervention block moved to './runner/intervention.ts'.)
import {
  INTERVENTION_COOLDOWN_TURNS,
  buildToolMisuseInterventionBlock,
} from './runner/intervention.js';

// (Pre-class helpers + tunable constants extracted to ./runner/* sub-modules —
// see the import block above. The corresponding doc-blocks live in those files.)
import { hashShort, rowToVerdictSnapshot } from './runner/dup-utils.js';
import { envInt, doomLoopThreshold } from './runner/constants.js';
import { capFor } from './runner/output-caps.js';
import { isEssentialCompanyTool } from './runner/company-essentials.js';

// Assembly modules — extracted in Commit 2 of the BT refactor. The legacy
// closures/methods below delegate to these so the BT's Executing node can
// reuse them once Commit 3 lands. Byte-identical to the legacy bodies.
import {
  buildTools as buildToolsImpl,
  buildToolsCacheKey as buildToolsCacheKeyImpl,
  fingerprintTools,
} from './runner/assembly/tools.js';
import { assembleMessagesForChat as assembleMessagesForChatImpl } from './runner/assembly/messages.js';

// Behavior Tree orchestrator — the SOLE execution path post-Frente-E.
// The legacy while-loop (formerly ~2400 LOC inside `run()`) was removed;
// `run()` now does a one-line delegation to `runViaBehaviorTree`, which
// builds the BridgeCallbacks and hands off to `runBehaviorTree`.
import { runBehaviorTree } from './runner/orchestrator.js';
// Pure per-turn telemetry insert. Wrapped by `persistTurnTelemetryWrapper`
// below with class-bound side effects (quality classifier + tool-
// selection observer) and exposed to the BT via `BridgeCallbacks`.
import { persistTurnTelemetry as persistTurnTelemetryPure } from './runner/telemetry/persist-turn.js';
import { checkTaskModeGate } from './runner/guards/task-mode-gate.js';

// (RESULT_DUP_ESCALATION_*, REPEATABLE_*, POLLING_STUCK_*, DUP_CALL_REMINDER_*,
// SUMMARIZER_*, RESULT_DUP_LARGE_THRESHOLD, RESULT_DUP_HEAD_CHARS, canRunSummarizer —
// all moved to './runner/constants.ts'. Doc-blocks live alongside them in that file.)

// (Dup-result / polling marker builders moved to './runner/markers.ts'.
// Re-exported below so external imports `from './runner.js'` keep working.)
import {
  buildDupLightMarker,
  buildDupWarnMarker,
  buildDupCallReminderMarker,
  buildPollingSoftCapMarker,
  buildPollingStuckRefusal,
  buildDupMediumMarker,
  ordinal,
} from './runner/markers.js';
export { buildDupLightMarker, buildDupWarnMarker, buildDupCallReminderMarker, buildPollingSoftCapMarker, buildPollingStuckRefusal, ordinal };

// (previewToolArgs / stableArgsKey / readDupThreshold / readDupWindow /
// readAutoDowngradeEnabled moved to './runner/dup-utils.ts'.)
import {
  previewToolArgs,
  stableArgsKey,
  readDupThreshold,
  readDupWindow,
  readAutoDowngradeEnabled,
} from './runner/dup-utils.js';
export { stableArgsKey };

// (Recovery circuit-breaker config + transient-retry tunables moved to
// './runner/recovery-config.ts'. Post-legacy-removal: only the symbols
// still consumed by `runViaBehaviorTree` / persistence / the BT bridge
// stay imported here — `preserveLastNTurns`, `transientRetry*` etc. were
// dead code paths from the legacy loop.)
import {
  type RecoveryKind,
  recoveryCap,
} from './runner/recovery-config.js';

// (nonRetryableProviderErrorReason + backoffDelayMs moved to './runner/provider-retry.ts'.)
import {
  nonRetryableProviderErrorReason,
  backoffDelayMs,
} from './runner/provider-retry.js';
export { backoffDelayMs };

// Cycle-aware dominance guard (Fix G — session 609's 50+ silent turns of
// `mcp__read_file`) is now implemented in `runner/guards/dominance.ts` and
// wired by the Executing node via `evaluatePerTurnLoops`. Its window/ratio
// tunables (`CODER_DOMINANCE_WINDOW`/`_RATIO`) live in `runner/constants.ts`
// (dominanceWindow/dominanceRatio). The dead consts that used to sit here
// were never read — the guard had no implementation until P0.
// Post-legacy-removal: the auto-continue cap lives entirely inside the
// BT's `MaxTurnsGuard` (`runner/guards/max-turns.ts:maxAutoContinues`).
// The duplicated `MAX_AUTO_CONTINUES` constant that used to drive the
// legacy while-loop is gone; the env var `CODER_MAX_AUTO_CONTINUES`
// continues to override the BT-side default.

/** How often (in turns) to re-inject the deliverable reminder for subordinate agents. */
const SUBORDINATE_REMINDER_INTERVAL = Number(process.env.CODER_SUBORDINATE_REMINDER_INTERVAL ?? 8);
const SUBORDINATE_REMINDER_MSG =
  '[System reminder] Before you stop or consider the task done, your LAST action MUST be ' +
  '`post_to_board` with kind="deliverable" summarizing your work. Never finish silently — ' +
  'the master is waiting for your report and cannot see your work any other way.';

// (toolCallsSignature + toolNamesSignature moved to './runner/signatures.ts'.)
import { toolCallsSignature, toolNamesSignature } from './runner/signatures.js';
export { toolCallsSignature, toolNamesSignature };

// (approxChars + shouldSpillToolOutput moved to './runner/pure-helpers.ts'.)
import {
  approxChars,
  shouldSpillToolOutput,
  capToolContent,
  finalizeToolOutput,
} from './runner/pure-helpers.js';
export { approxChars, shouldSpillToolOutput, capToolContent };
import { resolveFinalizeCap } from './runner/compaction/threshold.js';

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
  const capped = capToolContent(content, cap, outputId);
  if (!capped.truncated) {
    return { type: 'tool_result', tool_use_id: toolUseId, content, is_error: isError };
  }
  return {
    type: 'tool_result',
    tool_use_id: toolUseId,
    content: capped.content,
    is_error: isError,
    truncated: true,
    originalSize: capped.originalSize,
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
  /**
   * Optional tunables snapshot. When omitted, defaults to `envTunables()` —
   * env-driven behavior identical to the legacy module-level constants.
   * Runner instances pass `this.tunables` so per-session/per-tier overrides
   * flow through to the turn-budget warning threshold.
   */
  tunables?: CoderTunables,
  /** Per-turn reducer stats observer (telemetry — mig 143). */
  onReducerStats?: (s: { retired: number; freedChars: number; pendingRetired: number; pendingChars: number }) => void,
): AgentMessage[] {
  const effectiveTunables = tunables ?? envTunables();
  // Camada 5 — rolling reduction runs FIRST and is cheap (linear scan,
  // pure function, deterministic). It retires stale repeated reads/searches
  // before the size-based compaction even sees them, so sessions grow
  // sublinearly. Disabled via CODER_ROLLING_REDUCER=0 for diagnostics.
  // Retirements flush in tranches of CODER_REDUCER_FLUSH_CHARS so the
  // in-place rewrites (which bust the provider prompt-cache from that point
  // on) land as ONE batch instead of a per-turn trickle; 0 = legacy
  // apply-immediately.
  let working = messages;
  if (process.env.CODER_ROLLING_REDUCER !== '0') {
    const flushRaw = Number.parseInt(process.env.CODER_REDUCER_FLUSH_CHARS ?? '', 10);
    const flushThresholdChars = Number.isFinite(flushRaw) && flushRaw >= 0 ? flushRaw : 32768;
    const rolled = applyRollingReduction(messages, { flushThresholdChars });
    onReducerStats?.({
      retired: rolled.reduced,
      freedChars: rolled.freedChars,
      pendingRetired: rolled.pendingRetired,
      pendingChars: rolled.pendingChars,
    });
    if (rolled.reduced > 0) {
      console.log(
        `[coder] rolling reducer retired ${rolled.reduced} stale tool_result(s) ` +
          `(~${rolled.freedChars} chars freed, ${rolled.pendingRetired} pending below flush threshold)`,
      );
      working = rolled.messages;
    }
  }
  // Frente B (PR 2 da reavaliação) — char-based `compactMessages` foi
  // REMOVIDO. A compactação destrutiva agora é feita exclusivamente pelo
  // LLM compactor no nó `Compacting` (que dispara em ~75% do effective
  // context window). Aqui ficamos só com a `applyRollingReduction` acima
  // (Camada 5) e a sanitização de tool_use/tool_result orfãos abaixo.
  // O parâmetro `limits` agora é ignorado — assinatura mantida só por
  // compat de chamadores.
  void limits;
  const result = { messages: working, applied: false, prunedBlocks: 0, prunedChars: 0 };
  const total = approxChars(result.messages);
  if (total > effectiveTunables.turnBudgetChars) {
    console.warn(
      `[coder] turn payload ${total} chars exceeds budget ${effectiveTunables.turnBudgetChars}. ` +
      `Lower CODER_PUSH_TIME_CAP or increase CODER_TURN_BUDGET_CHARS.`,
    );
  }

  // Safety nets (orphan tool_result removal → synthetic tool_result
  // injection for orphaned tool_use → consecutive same-role merge) live in
  // `repairToolPairing` — extracted verbatim to core/transcript-repair.ts so
  // the subagent resume path sanitizes captured transcripts with the exact
  // same logic. One implementation, two call sites.
  return repairToolPairing(result.messages);
}

// (RunnerEvents interface moved to './runner/events.ts'. Re-exported below
// so external imports `from './runner.js'` keep their type paths unchanged.)
import type { RunnerEvents } from './runner/events.js';
export type { RunnerEvents };

// (RunnerEvents body moved to './runner/events.ts'.)

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
  /**
   * Pending `waitForUserInput()` continuations, keyed by `askId`.
   *
   * PR-E (execute_tasks budget cap) introduced concurrent ask_user paths:
   * the master may be paused on a regular `ask_user` tool while
   * `execute_tasks` separately awaits a budget decision. A single-slot
   * implementation produced a race where the second wait overwrote the
   * first and the first resolved with the wrong answer.
   *
   * Keyed semantics:
   *   - Callers omit `askId` to use the historic single-slot key
   *     (`__default__`) — backward compatible with `ask_user`,
   *     `submit_plan`, `submit_tasks`, `subordinate.ask_master`, etc.
   *   - Callers pass an `askId` (e.g. `budget_<runId>_<turn>`) when they
   *     need an independent slot.
   *   - `provideUserInput(value, askId?)` resolves the matching slot only.
   *   - `abort()` and `interruptWait()` resolve EVERY pending slot.
   */
  private pendingResolves: Map<string, (value: string) => void> = new Map();
  /**
   * Supervisor recovery (Phase 2.3). In-flight non-interactive tool calls,
   * keyed by tool_use_id — the dispatch loop registers each call's
   * AbortController so `injectToolResultError` can unwedge a single stuck call
   * without killing the run. `injectedToolErrors` carries the message dispatch
   * surfaces as the aborted call's tool_result.
   */
  private readonly inFlightTools: Map<string, AbortController> = new Map();
  private readonly injectedToolErrors: Map<string, string> = new Map();
  private static readonly DEFAULT_INPUT_KEY = '__default__';
  private pendingUserMessages: Array<{ text: string; selectedSkillIds?: string[] }> = [];
  /** Resolvers woken when a user message is queued — lets the background-job
   *  parking gate wake the instant the user speaks (not just on job settle). */
  private pendingMessageWaiters: Array<() => void> = [];
  private agentDecisionSwitchAsked = false;
  private planApproved = false;
  /** Set by `approveSpec()` after the user accepts a `submit_spec` submission. */
  private specApproved = false;
  /** Repo-relative path of the most recently approved spec (`.mcp/specs/<slug>-<unix>.md`). */
  private specPath: string | null = null;
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
   * PR-5 (Row 32) — pre-read enforcement. Tracks recent read-family tool
   * calls keyed by (toolName, path, slice-fields) so the runner can REFUSE
   * a duplicate before dispatching it. Used by `enforcePreReadForBridge`.
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
   * Session-drive "guide files" signal — the files this session edited, most
   * recently first, capped. Feeds `collectDynamicInjectionSignals`; the
   * dynamic injector dedups so each file is surfaced to the model once.
   */
  private recentEditedFilesForInjection(): string[] {
    if (this.recentWrites.size === 0) return [];
    return [...this.recentWrites.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([path]) => path)
      .slice(0, 8);
  }

  /**
   * Set by the pre-read guard when it decides to ALLOW a re-read after a
   * mutation: keyed by the new tool_use id (block.id), points to the prior
   * read's useId/turn so the post-dispatch hook can replace the new
   * tool_result content with a unified diff. Cleared per turn boundary
   * (entries naturally expire as the keys go out of scope).
   */
  private pendingDiffRereads: Map<string, { priorUseId: string; priorTurn: number; path: string }> = new Map();


  /**
   * Rolling list of tool names called recently (newest at the end).
   * Maintained alongside the dominance window but with a wider cap so
   * the QualityWatchdog can run histogram analysis on a longer horizon
   * than the dominance guard. Trimmed lazily when it grows past 60.
   *
   * Distinct from `toolCallFreq` (which is keyed by arg-hash for the
   * dup-call cap) — the watchdog wants tool *name* repetition, not
   * arg repetition.
   */
  private watchdogRecentNames: string[] = [];

  /**
   * Rolling snapshot of recent tool calls (with isError + argsPreview)
   * forwarded to the watchdog when its LLM check runs. Same cap as
   * `watchdogRecentNames` — they evict in lockstep.
   */
  private watchdogRecentCalls: Array<{
    turn: number;
    name: string;
    isError: boolean;
    argsPreview?: string;
  }> = [];

  /**
   * Last turn the QualityWatchdog LLM was invoked. Used to enforce the
   * cooldown so the watchdog doesn't burn tokens every turn during a
   * sustained loop. `-Infinity` = never yet.
   */
  private lastWatchdogTurn = -Infinity;

  /**
   * When the watchdog returns `flagged` with `recommended_action='nudge'`,
   * this string holds the synthetic system reminder the runner injects
   * before the next provider call. Consumed-and-cleared once.
   */
  private pendingWatchdogNudge: string | null = null;

  /**
   * Lightweight checklist (the `track` gate of the unified task list). Since
   * the todos/tasks merge this is a DERIVED VIEW over the single task store
   * (`coder_tasks_state`): it returns the track-gate items as `TodoItem[]`, or
   * `[]` when the active list is an `approve` list (or there is none). Writes
   * go through {@link setTodos}, which records a track `TasksState`. The
   * `todos_updated` event still fires so the dashboard sidebar stays live.
   */
  get currentTodos(): TodoItem[] {
    const ctx = this.opts.toolContext;
    return deriveTodosFromState(ctx.getTasksState ? ctx.getTasksState() : null);
  }

  /**
   * Worktree scope tracking. When `enter_worktree` is called, the runner
   * remembers the original project root in `originalCwd` and swaps
   * `toolContext.cwd` for the worktree path. `exit_worktree` reverses both.
   * Persisted in `coder_sessions.worktree_path` so a session resume after a
   * server restart continues in the same worktree.
   */
  public originalCwd: string | null = null;
  public worktreePath: string | null = null;



  /**
   * Phase C — polling-result stuck detection. Tracks the most recent
   * consecutive run of identical result content per polling tool. When
   * a run reaches `POLLING_STUCK_CAP`, the next call's result is
   * replaced with a refusal so the agent stops polling stuck state.
   */
  private pollingResultRun: Map<string, { hash: string; count: number; firstTurn: number }>
    = new Map();



  /**
   * Wire #2 — Tool-misuse streak intervention bookkeeping.
   *
   * When the `tool_misuse` classifier flags 3 consecutive turns, the runner
   * forces the NEXT turn into a "planning intervention" — appends a strong
   * directive to the system prompt telling the model to stop, name the
   * loop, propose a different approach. Without this counter, the
   * intervention would re-fire on every subsequent turn while the streak
   * verdicts are still in the recent-window — annoying and wasteful.
   *
   * We record the turn number at which we LAST intervened, and require at
   * least N more turns to pass before considering re-intervention.
   */
  private lastToolMisuseInterventionTurn: number | null = null;

  /**
   * Quality v2, A2 — In-flight classifier Promises, keyed by the turn
   * they were fired for. The next turn's `buildQualityFeedbackSuffix`
   * races this Promise against a 2s timeout so the nudge text actually
   * reflects the latest verdicts (vs the fire-and-forget v1 which left
   * a race window where the next turn's prompt was assembled BEFORE
   * the prior turn's classifier finished).
   *
   * Auto-cleaned: entries older than `this.turn - 3` are dropped to
   * avoid memory leak in long sessions.
   */
  private pendingClassifyByTurn = new Map<number, Promise<QualityResult | null>>();

  /**
   * Quality v2, D1 — Last-emitted nudge hash per turn. When the nudge
   * text is byte-identical to one emitted in the last 5 turns, we suppress
   * the duplicate (the model already received this message) but still
   * record the suppression event so the dashboard can show "nudge fired
   * → suppressed because identical to recent".
   */
  private lastNudgeHashByTurn = new Map<number, string>();

  /**
   * Quality v2, C4 — Pending intervention ids per turn. The runner inserts
   * a row into `quality_interventions` with outcome='pending' the moment
   * a nudge or planning block is appended; the value here is the row id.
   * Later, when the classifier for turn (N+1) completes, the global
   * runner reads this Map and backfills `outcome` based on verdict delta.
   */
  private pendingInterventionByTurn = new Map<number, number>();

  /**
   * Quality v2 — Held-out counterfactual rate. A qualifying nudge is
   * deterministically withheld with this probability so the dashboard can
   * compare improved-rate WITH vs WITHOUT a nudge on the same population
   * (a real A/B baseline — `nudge_suppressed` is NOT a baseline, it's the
   * repeat/dedup'd subset). 0 disables; default 0.15. Set via
   * `CODER_NUDGE_HOLDOUT_RATE`.
   */
  private readonly nudgeHoldoutRate = parseNudgeHoldoutRate(process.env.CODER_NUDGE_HOLDOUT_RATE);


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
   * Update the rolling watchdog state with the tools this turn just
   * fired. Cheap — no LLM. The actual `analyze()` call happens via
   * `maybeRunWatchdog()` below and only when the pre-filter says the
   * loop pattern is suspicious AND the cooldown has elapsed.
   */
  private recordToolCallsForWatchdog(
    turn: number,
    blocks: Array<{ name: string; input: Record<string, unknown> }>,
    isErrorPerBlock: boolean[],
  ): void {
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i];
      this.watchdogRecentNames.push(b.name);
      let argsPreview: string | undefined;
      try {
        argsPreview = JSON.stringify(b.input ?? {}).slice(0, 80);
      } catch {
        argsPreview = undefined;
      }
      this.watchdogRecentCalls.push({
        turn,
        name: b.name,
        isError: isErrorPerBlock[i] ?? false,
        argsPreview,
      });
    }
    // Cap rolling window at 60 — wide enough for the watchdog's histogram
    // to be meaningful, narrow enough to keep memory flat across long runs.
    while (this.watchdogRecentNames.length > 60) this.watchdogRecentNames.shift();
    while (this.watchdogRecentCalls.length > 60) this.watchdogRecentCalls.shift();
  }

  /**
   * Run the QualityWatchdog asynchronously (fire-and-forget) when the
   * cheap pre-filter detects a suspect pattern AND the cooldown has
   * elapsed. The watchdog's LLM call doesn't block the turn loop — its
   * verdict, if `flagged`, queues a system reminder for the NEXT turn
   * via `pendingWatchdogNudge`.
   *
   * Lives separately from the four existing guards because:
   *   - It runs on cheap heuristic + LLM, not pure-heuristic
   *   - It catches semantic patterns (e.g. "model keeps trying to fix
   *     a missing import that doesn't exist") the others miss
   *   - It nudges instead of aborting — the existing guards still
   *     abort the run when their thresholds hit
   */
  private maybeRunWatchdog(turn: number, lastAssistantText: string): void {
    const watchdog = getGlobalQualityWatchdog();
    if (!watchdog) return;
    if (turn - this.lastWatchdogTurn < watchdog.cooldownTurns) return;
    const trigger = watchdog.shouldRun(this.watchdogRecentNames);
    if (!trigger) return;
    this.lastWatchdogTurn = turn;
    const sessionId = this.sessionId ?? 0;
    const recentCalls = [...this.watchdogRecentCalls];
    const text = lastAssistantText.slice(0, 1500);
    void watchdog
      .analyze({ sessionId, turn, recentToolCalls: recentCalls, lastAssistantText: text })
      .then((verdict) => {
        this.handleWatchdogVerdict(verdict, turn, trigger.suspectTool);
      })
      .catch((e) => {
        // Apêndice 4 Fase 1 — include name + stack so the post-mortem
        // can tell a network blip apart from a TypeError in our own
        // code. Previously this was just `e.message` which often left
        // the failure mode ambiguous.
        const name = e instanceof Error ? e.name : 'unknown';
        const message = e instanceof Error ? e.message : String(e);
        const stack = e instanceof Error ? e.stack : undefined;
        console.warn(
          `[quality-watchdog] analyze failed at turn ${turn}: ${name}: ${message}` +
            (stack ? `\n${stack}` : ''),
        );
      });
  }

  /**
   * Apply a watchdog verdict. Persists the row, emits the bus event,
   * and queues a system reminder when the verdict warrants a nudge.
   * Pure side-effects — does not throw.
   */
  private handleWatchdogVerdict(
    verdict: import('@mcp/services/quality/index.js').WatchdogVerdict,
    turn: number,
    suspectTool: string,
  ): void {
    try {
      const store = getGlobalQualityClassificationStore();
      if (store) {
        // Reuse the existing classifier storage so the dashboard /
        // admin panels show watchdog verdicts alongside the 5-classifier
        // pipeline rows. `classifier_name='tool_loop'` keeps them
        // distinguishable.
        store.insert({
          session_id: this.sessionId ?? null,
          company_session_id: this.opts.companySessionId ?? null,
          agent_run_id: this.opts.companyAgentRunId ?? null,
          classifier_name: verdict.classifierName,
          verdict: verdict.verdict,
          confidence: verdict.confidence ?? null,
          reason: verdict.reason ?? null,
          provider_id: verdict.providerId ?? null,
          model_id: verdict.modelId ?? null,
          latency_ms: verdict.latencyMs,
          raw_response: verdict.raw,
        });
      }
    } catch (e) {
      console.warn(
        `[quality-watchdog] persistence failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    this.emit('quality_watchdog_alert', {
      turn,
      sessionId: this.sessionId ?? 0,
      suspectTool,
      verdict: verdict.verdict,
      confidence: verdict.confidence ?? 0,
      reason: verdict.reason ?? '',
      recommendedAction: verdict.recommendedAction,
      providerId: verdict.providerId ?? '',
      modelId: verdict.modelId ?? '',
    });
    if (
      verdict.verdict === 'flagged' &&
      (verdict.recommendedAction === 'nudge' || verdict.recommendedAction === 'stop')
    ) {
      const reason = verdict.reason || `Tool \`${suspectTool}\` appears stuck.`;
      this.pendingWatchdogNudge =
        `[QUALITY WATCHDOG] ${reason} ` +
        `Switch strategy: ask the user, try a different tool, or call update_goal/finish if the work is done. ` +
        `Repeating \`${suspectTool}\` will not produce new information.`;
      console.warn(
        `[quality-watchdog] flagged session=${this.opts.sessionId} turn=${turn} ` +
          `tool=${suspectTool} action=${verdict.recommendedAction}`,
      );
    }
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
   * Tools the model called by name while they were hidden (tier-hidden or
   * cap-cut by the model's maxTools). Dispatch executes the call anyway,
   * adds the name here, and the next turn's `buildTools` unions it into
   * the visible list (protected from the cap). Monotone like activeTiers;
   * shared BY REFERENCE with the BT's RunContext.
   */
  public pinnedTools: Set<string> = new Set();

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
  public readonly sessionStore: import('@mcp/code-agent/sessions/store.js').SessionStore | undefined;
  /**
   * Resolved per-block tool-result cap for this run. Computed once in the
   * constructor from `opts.toolOutputCapLevel`, `opts.pushTimeCap`, and
   * `opts.isSubagent`. All callsites that previously read
   * `this.effectivePushTimeCap` should use this instead so the
   * unrestricted ceiling stays consistent across `buildToolResultBlock`
   * arguments and the side-file `toolOutputStore` gate.
   */
  public readonly effectivePushTimeCap: number;

  /**
   * Resolved tunables for this run. Defaults to `envTunables()` when
   * `opts.tunables` is absent — i.e. legacy env-driven behavior. Hosts that
   * want per-session/per-tier control pass a snapshot built from the Decider.
   */
  public readonly tunables: CoderTunables;

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
   * Quality v2, A1 — Cheap DB peek to feed `shouldClassifyTurn`. Returns
   * the worst verdict from the MOST RECENT classified turn (or null when
   * no prior classification exists). Bounded to the last 30 rows so it
   * stays a single indexed query.
   *
   * Never throws — DB errors return null (sampling falls through to the
   * default 1/3 rate).
   */
  private peekLastSessionWorstVerdict(): import('@mcp/store/quality-classification-store.js').QualityVerdict | null {
    try {
      if (this.sessionId == null) return null;
      const store = getGlobalQualityClassificationStore();
      if (!store) return null;
      const rows = store.findRecentBySession(this.sessionId, {
        limit: 5, // 5 classifiers per turn — captures last turn's verdicts
        sinceMs: 10 * 60_000,
      });
      if (rows.length === 0) return null;
      // Filter to rows from the SINGLE most recent turn (same message_id).
      const newestMessageId = rows[0].message_id;
      const lastTurnRows = rows.filter((r) => r.message_id === newestMessageId);
      return worstVerdictOf(lastTurnRows);
    } catch {
      return null;
    }
  }

  /**
   * Quality v2, A2 — Wait briefly for the PRIOR turn's classifier Promise
   * to complete so `buildQualityFeedbackSuffix` reads fresh verdicts.
   *
   * Behavior:
   *   - When no Promise is pending → returns immediately ('no_op').
   *   - When the Promise resolves within `timeoutMs` (default 2000) →
   *     returns 'resolved'. The DB will have the verdicts; the
   *     subsequent sync builder picks them up.
   *   - On timeout → returns 'timed_out'. The builder still runs; nudge
   *     may be empty for this turn (acceptable — fires next turn).
   *
   * Configurable timeout via env `MCP_QUALITY_NUDGE_WAIT_TIMEOUT_MS`.
   * Setting it to `0` disables the wait entirely (back to v1 race behavior).
   *
   * Never throws — any error path returns 'no_op' to fail safely.
   */
  private async awaitPriorTurnClassifier(): Promise<'no_op' | 'resolved' | 'timed_out'> {
    try {
      const timeoutMs = Number(process.env.MCP_QUALITY_NUDGE_WAIT_TIMEOUT_MS ?? 2000);
      if (timeoutMs <= 0) return 'no_op';
      const priorTurn = this.turn - 1;
      const pending = this.pendingClassifyByTurn.get(priorTurn);
      if (!pending) return 'no_op';
      let timeoutId: NodeJS.Timeout | undefined;
      const timeoutSentinel = Symbol('timeout');
      const race = await Promise.race<unknown>([
        pending,
        new Promise((resolve) => {
          timeoutId = setTimeout(() => resolve(timeoutSentinel), timeoutMs);
        }),
      ]);
      if (timeoutId) clearTimeout(timeoutId);
      // Consumed — drop so a re-entry doesn't re-await the same Promise.
      this.pendingClassifyByTurn.delete(priorTurn);
      return race === timeoutSentinel ? 'timed_out' : 'resolved';
    } catch {
      return 'no_op';
    }
  }

  /**
   * Wires #1 + #2 — Build the per-turn quality-feedback suffix that gets
   * appended to the static system prompt at chat-call time.
   *
   * This is the place where the quality classifiers stop being a passive
   * monitor and start affecting the model's next reply:
   *
   *   - **Wire #1 (Nível 1 — soft nudge):** for every classifier that
   *     emitted a `warn`/`flagged` verdict above the confidence floor in
   *     the recent window, a one-line corrective hint is appended.
   *
   *   - **Wire #2 (Nível 3a — tool-misuse intervention):** when the last 3
   *     `tool_misuse` rows are all flagged AND we haven't intervened in
   *     the last `INTERVENTION_COOLDOWN_TURNS` turns, the runner appends
   *     a strong "planning turn" directive that overrides the soft nudge.
   *
   * Returns the SUFFIX text (empty string when nothing to inject). The
   * caller concatenates it onto `this.opts.systemPrompt` for the chat
   * call — the cached prefix isn't broken because we only ADD to the
   * end. Subsequent turns without any feedback restore the unmodified
   * prompt, so the prefix cache picks up where it left off.
   *
   * Never throws. Any DB / store failure returns ''.
   */
  private buildQualityFeedbackSuffix(): string {
    try {
      if (this.sessionId == null) return '';
      const store = getGlobalQualityClassificationStore();
      if (!store) return '';

      // Read a small recent window — enough to find the latest verdict per
      // classifier and detect the 3-streak. 30 rows × 5 minutes is plenty;
      // older verdicts are stale and likely refer to a problem the model
      // has already moved past.
      const rows = store.findRecentBySession(this.sessionId, {
        limit: 30,
        sinceMs: 5 * 60_000,
      });
      if (rows.length === 0) return '';

      const parts: string[] = [];
      let planningTriggered = false;
      let planningContextRows: QualityClassificationRow[] = [];

      // Wire #2 first — if the streak triggers, it takes precedence over
      // the soft nudge (the soft nudge text would dilute the intervention).
      const cooldown = this.tunables.interventionCooldownTurns;
      const lastIv = this.lastToolMisuseInterventionTurn;
      const cooldownOk = lastIv == null || this.turn - lastIv >= cooldown;
      if (cooldownOk) {
        const streak = detectToolMisuseStreak(rows, { minConfidence: 0.5, streakLength: 3 });
        if (streak.triggered) {
          parts.push(buildToolMisuseInterventionBlock(streak.latestReason, streak.latestConfidence));
          this.lastToolMisuseInterventionTurn = this.turn;
          planningTriggered = true;
          planningContextRows = rows.filter((r) => r.classifier_name === 'tool_misuse').slice(0, 3);
        }
      }

      // Wire #1 — always considered; emits empty when nothing meets the bar.
      // When the intervention block above fired, we still emit the soft nudge
      // (it covers the OTHER classifiers — off_topic, code_quality, etc.).
      const nudge = buildQualityNudge(rows, { minConfidence: 0.6 });
      let nudgeEmitted = false;
      let nudgeSuppressed = false;
      let nudgeHeldOut = false;
      if (nudge.text) {
        // Quality v2, D1 — Dedup identical nudges within a 5-turn window.
        // When the same text fires turn after turn, the model has already
        // received the signal; re-injecting it pollutes the prompt and
        // wastes cache. We still record the suppression event so the
        // dashboard can show "nudge fired internally but suppressed".
        const hash = hashShort(nudge.text);
        const recentlySent = Array.from(this.lastNudgeHashByTurn.entries()).some(
          ([t, h]) => h === hash && this.turn - t < 5,
        );
        if (recentlySent) {
          nudgeSuppressed = true;
        } else if (this.shouldHoldOutNudge()) {
          // Quality v2 — Counterfactual control. This nudge QUALIFIED but we
          // deliberately withhold it (deterministic per session×turn) so the
          // dashboard can compare improved-rate WITH vs WITHOUT a nudge on the
          // same population. Do NOT inject the text, and do NOT record the
          // hash — a future identical nudge must still fire, since the model
          // never actually received this one.
          nudgeHeldOut = true;
        } else {
          parts.push(nudge.text);
          nudgeEmitted = true;
          this.lastNudgeHashByTurn.set(this.turn, hash);
          // Trim old entries (anything older than 10 turns is no longer
          // relevant for the 5-turn dedup window, with margin).
          for (const t of this.lastNudgeHashByTurn.keys()) {
            if (t < this.turn - 10) this.lastNudgeHashByTurn.delete(t);
          }
        }
      }

      const finalText = parts.length > 0 ? `\n${parts.join('\n')}` : '';

      // Quality v2, C4 — Record the intervention(s) for effectiveness
      // measurement. Outcome starts 'pending' and is backfilled by the
      // next classifier turn (in global-classifier-runner.ts).
      if (planningTriggered) {
        this.recordIntervention(
          'planning',
          // Triggering verdicts: the streak that fired the intervention.
          planningContextRows.map(rowToVerdictSnapshot),
          finalText.length,
        );
      }
      // nudge / nudge_holdout / nudge_suppressed are mutually exclusive and
      // share the same triggering verdicts (one per contributing classifier),
      // so the backfill scores all three identically — that's what makes the
      // held-out rows a valid counterfactual baseline.
      if (nudgeEmitted || nudgeHeldOut || nudgeSuppressed) {
        const triggers = rows
          .filter((r) => nudge.contributingClassifiers.includes(r.classifier_name))
          // Dedupe by classifier_name keeping most recent (rows are DESC).
          .filter((r, i, arr) => arr.findIndex((x) => x.classifier_name === r.classifier_name) === i)
          .map(rowToVerdictSnapshot);
        if (nudgeEmitted) {
          this.recordIntervention('nudge', triggers, finalText.length);
        } else if (nudgeHeldOut) {
          this.recordIntervention('nudge_holdout', triggers, 0);
        } else {
          this.recordIntervention('nudge_suppressed', triggers, 0);
        }
      }

      return finalText;
    } catch {
      // Feedback is best-effort; a DB error must never break a turn.
      return '';
    }
  }

  /**
   * Quality v2 — Decide whether to hold out (withhold) a qualifying nudge
   * for the counterfactual baseline. Deterministic per (session, turn) and
   * salted so it's decorrelated from the classification-sampling decision —
   * reproducible across re-runs and unbiased.
   */
  private shouldHoldOutNudge(): boolean {
    if (this.nudgeHoldoutRate <= 0) return false;
    if (this.sessionId == null) return false;
    return fnv1aSample(this.sessionId, this.turn, 'nudge_holdout') < this.nudgeHoldoutRate;
  }

  /**
   * Quality v2, C4 — Persist an intervention row with outcome='pending'.
   * Never throws. Silently no-op when the global store isn't installed
   * (tests, opt-out env, etc).
   */
  private recordIntervention(
    type: 'nudge' | 'planning' | 'nudge_suppressed' | 'nudge_holdout',
    triggers: ReadonlyArray<InterventionVerdictSnapshot>,
    chars: number,
  ): void {
    try {
      const store = getGlobalQualityInterventionStore();
      if (!store) return;
      const id = store.insert({
        session_id: this.sessionId ?? null,
        company_session_id: this.opts.companySessionId ?? null,
        agent_run_id: this.opts.companyAgentRunId ?? null,
        turn_fired: this.turn,
        intervention_type: type,
        triggering_verdicts: triggers,
        nudge_chars: chars > 0 ? chars : null,
      });
      // Track pending id per turn for future synchronous backfill flows
      // (currently the global runner backfills on the next classify cycle
      // by querying findPendingByPriorTurn — this map is informational
      // and could be used by future inline-effectiveness UI).
      if (type !== 'nudge_suppressed') {
        this.pendingInterventionByTurn.set(this.turn, id);
        for (const t of this.pendingInterventionByTurn.keys()) {
          if (t < this.turn - 5) this.pendingInterventionByTurn.delete(t);
        }
      }
    } catch {
      /* never throw */
    }
  }

  /**
   * Extract the latest assistant text content (concatenated across text
   * blocks). Used by the quality classifier observer to score the
   * agent's just-emitted reply.
   */
  private extractLastAssistantText(): string {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const m = this.messages[i];
      if (m.role !== 'assistant') continue;
      if (typeof m.content === 'string') return m.content;
      const parts: string[] = [];
      for (const b of m.content) {
        if (b.type === 'text') parts.push(b.text);
      }
      if (parts.length > 0) return parts.join(' ');
    }
    return '';
  }

  constructor(opts: RunnerOptions) {
    super();
    this.opts = opts;
    this.sessionId = opts.sessionId;
    this.isSubagent = opts.isSubagent ?? false;
    this.sessionStore = opts.sessionStore;
    // Resolve tunables once. When opts.tunables is omitted, envTunables()
    // reproduces the legacy CODER_*-from-env behavior bit-identically.
    this.tunables = opts.tunables ?? envTunables();
    // Resolve the per-block tool-result cap once from the session's cap LEVEL
    // (economic|medium|high|extra|max|ultra). `economic` preserves the legacy
    // precedence: explicit opts.pushTimeCap (subagent factories) → per-session
    // tunables base. Any elevated level applies the multiplier/ceiling via
    // capFor() against the main/subagent (base, ceiling) pair.
    const capLevel = opts.toolOutputCapLevel ?? 'economic';
    const capBase = this.isSubagent ? this.tunables.subagentPushTimeCap : this.tunables.pushTimeCap;
    const capCeiling = this.isSubagent
      ? this.tunables.unrestrictedSubagentPushTimeCap
      : this.tunables.unrestrictedPushTimeCap;
    this.effectivePushTimeCap =
      capLevel === 'economic' ? (opts.pushTimeCap ?? capBase) : capFor(capLevel, capBase, capCeiling);
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
    // Pins seeded by the host on resume — history tools outside the active
    // tiers, unioned with the session-persisted pins (mig 142); see runCoder.
    if (opts.initialPinnedTools) {
      this.pinnedTools = new Set(opts.initialPinnedTools);
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
    // Sticky toolset (mig 142): let the host persist the widen so resumes
    // rebuild the same tool array. Persistence never breaks the promotion.
    try { this.opts.onTierPromoted?.(tier); } catch { /* best-effort */ }
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
  setTodos(todos: TodoItem[]): void {
    // Defensive copy — the tool may mutate its input later.
    const next = todos.map((t) => ({ ...t }));
    // One store: a checklist write is a track-gate `TasksState`. record()
    // skips its approve-flow merge for track gate (authoritative full
    // replacement). When there is no task store (ephemeral/subagent runners),
    // we simply emit so any live listener still updates.
    const ctx = this.opts.toolContext;
    if (ctx.recordTasks) {
      ctx.recordTasks(
        `track_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
        buildTrackState(next),
      );
    }
    this.emit('todos_updated', { todos: next });
  }






  /**
   * Build the `<active-context>` block from live state, plus the sibling
   * `<indexed-docs>` block (project-linked doc collections). Returns null
   * when both are empty. Both ride the trailing user message — never the
   * system prompt — so the prefix cache is untouched.
   */
  private buildActiveContextBlockForTurn(): string | null {
    const ctx = this.opts.toolContext;
    const goal = ctx.getGoalState ? ctx.getGoalState() : null;
    const tasksState = ctx.getTasksState ? ctx.getTasksState() : null;
    const base = buildActiveContextBlock({
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
    const docs = buildIndexedDocsBlock(ctx.projectId);
    if (!docs) return base;
    return base ? `${base}\n\n${docs}` : docs;
  }

  /**
   * Resolve `selectedSkillIds` carried on the trailing user message into a
   * wrapped `<active_skills>` block ready to be appended verbatim. Returns
   * null when no skills were picked, the skillStore is unwired, or every
   * picked ID was unknown (handled silently — the user already got UI
   * feedback at pick time).
   *
   * Logs one `skill_usage_log` row per applied skill with
   * `invoked_by='user'` so the admin telemetry tab can attribute manual
   * picks. Best-effort: a logging failure does not block the request.
   */
  private buildActiveSkillsBlockForLastUser(history: AgentMessage[]): string | null {
    const store = this.opts.skillStore;
    if (!store) return null;
    const lastIdx = history.length - 1;
    if (lastIdx < 0) return null;
    const last = history[lastIdx];
    if (last.role !== 'user') return null;
    const ids = last.selectedSkillIds;
    if (!ids || ids.length === 0) return null;

    const userInput = last.content
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map((b) => b.text)
      .join('\n');
    const ctx: SkillTemplateContext = {
      SESSION_ID: this.sessionId != null ? String(this.sessionId) : '',
      PROJECT_NAME: this.opts.toolContext.projectName ?? '',
      PROJECT_ROOT: this.opts.toolContext.cwd ?? '',
      OS: process.platform,
      TIMESTAMP: new Date().toISOString(),
      USER_INPUT: userInput,
    };

    const seen = new Set<string>();
    const blocks: string[] = [];
    for (const id of ids) {
      if (seen.has(id)) continue;
      seen.add(id);
      const skill = store.getSkill(id);
      if (!skill) continue;
      const body = interpolateSkillVars(skill.prompt_body, ctx);
      blocks.push(`## ${skill.id} — ${skill.name}\n\n${body}`);
      if (this.sessionId != null) {
        try {
          store.logSkillUsage({
            session_id: this.sessionId,
            skill_id: id,
            invoked_by: 'user',
            input_text: userInput,
          });
        } catch {
          /* telemetry is best-effort; do not block the turn */
        }
      }
    }

    if (blocks.length === 0) return null;
    return `<active_skills>\n${blocks.join('\n\n')}\n</active_skills>`;
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
  getToolListSnapshot(): import('@mcp/code-agent/core/tool.js').CoderTool[] {
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
  get agentId(): import('@mcp/code-agent/agents/index.js').AgentId | null | undefined {
    return this.opts.agentId;
  }

  /**
   * Aplica um switch de agente ao vivo no runner em execução: muta opts para
   * que o gate / tier filter / system-prompt do próximo turno leiam o novo
   * modo, e reseta as flags de aprovação ao entrar num modo com gate.
   * Espelha o que o construtor deriva de AGENTS[id] no início do run.
   */
  applyLiveAgent(
    def: import('@mcp/code-agent/agents/index.js').AgentDefinition,
    agent: import('@mcp/code-agent/agents/index.js').AgentId,
  ): void {
    this.opts.planMode = def.planMode ?? false;
    this.opts.specMode = def.specMode ?? false;
    this.opts.agentId = agent;
    // Mantém toolContext.planMode em sincronia — igual ao construtor; tier
    // filter / system prompt leem daqui.
    this.opts.toolContext.planMode = this.opts.planMode;
    if (this.opts.planMode) this.resetPlanApproval();
    if (this.opts.specMode) this.resetSpecApproval();
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

  /**
   * Pause the current tool call, waiting for the host (CLI/SSE) to call
   * provideUserInput. Pass `askId` to use an independent slot — see the
   * comment on `pendingResolves` for the concurrency story.
   */
  waitForUserInput(askId?: string): Promise<string> {
    const key = askId ?? CoderRunner.DEFAULT_INPUT_KEY;
    // Signal the host that this turn is about to block indefinitely so it can
    // durably checkpoint the in-flight assistant message (incl. the pending
    // interactive tool_use). Without this, a quit/close before the user
    // approves loses the whole turn — the unflushed pause cannot be resumed
    // (see findPendingInteraction in apps/http-api .../coder/state.ts).
    this.emit('awaiting_input', { askId: key });
    return new Promise((resolve) => {
      this.pendingResolves.set(key, resolve);
    });
  }

  /** Resume a paused tool call with the user's answer. */
  provideUserInput(value: string, askId?: string): boolean {
    const key = askId ?? CoderRunner.DEFAULT_INPUT_KEY;
    const r = this.pendingResolves.get(key);
    if (!r) return false;
    this.pendingResolves.delete(key);
    r(value);
    return true;
  }

  /**
   * True while the runner is blocked inside waitForUserInput(). When
   * `askId` is provided, scopes the check to that specific slot.
   */
  isWaitingForInput(askId?: string): boolean {
    if (askId !== undefined) return this.pendingResolves.has(askId);
    return this.pendingResolves.size > 0;
  }

  /**
   * Break ALL pending waitForUserInput() slots by resolving each with an
   * interrupt signal. The blocked tool receives { interrupted: true, ...info }
   * and should return an error result so the master can handle the urgent
   * request (e.g. a subordinate blocked on ask_master) before re-asking.
   *
   * Optional `info` is forwarded so blocked tools can surface a structured
   * `next_action` to the agent (which subordinate, which master tool to
   * call) instead of relying on a notification user-message arriving in
   * time.
   */
  interruptWait(info?: { kind?: 'plan' | 'question' | 'tasks' | 'subordinate_event'; agentRunId?: number; role?: string }): boolean {
    if (this.pendingResolves.size === 0) return false;
    const payload = JSON.stringify({ interrupted: true, ...(info ?? {}) });
    const resolvers = Array.from(this.pendingResolves.values());
    this.pendingResolves.clear();
    for (const r of resolvers) r(payload);
    return true;
  }

  /** Marks the latest plan as approved so mutating tools become unblocked. */
  approvePlan(): void {
    this.planApproved = true;
  }

  /**
   * Reset the plan-approval flag. Called when the runner is switched
   * back into plan mode mid-session (e.g. an `admin` agent flips to
   * `plan` via `setSessionAgent`) so the gate re-engages until a fresh
   * `submit_plan` is approved.
   */
  resetPlanApproval(): void {
    this.planApproved = false;
  }

  /** Whether mutating tools should be allowed right now. */
  isPlanApproved(): boolean {
    return this.planApproved;
  }

  // ─── Decision-gate accounting (plan mode) ──────────────────────────
  // Per-run counters backing the soft-mandatory decision-gate nudge (see
  // executing-plan-gate.ts `maybeDecisionGateNudge`, fired from the
  // submit_plan handler). Stored on the runner — not RunContext — because the
  // tool handlers reach the runner via `ctx.runner`, not the machine context.
  private decisionAsks = 0;
  private decisionGateNudges = 0;
  /**
   * Record that a genuine decision was put to the user this run — a
   * `decision_gate` call, or an `ask_user` with options. Suppresses the
   * one-shot decision-gate nudge so well-behaved runs never see it.
   */
  noteDecisionAsk(): void {
    this.decisionAsks += 1;
  }
  /** How many genuine decisions were put to the user this run. */
  get decisionAskCount(): number {
    return this.decisionAsks;
  }
  /** Record that the one-shot decision-gate nudge fired (caps it at one). */
  noteDecisionGateNudge(): void {
    this.decisionGateNudges += 1;
  }
  /**
   * Re-arm the one-shot decision-gate nudge. Called when the user REJECTS a
   * plan: the model is going to revise and re-submit, and if the revised plan
   * still exposes an unconsulted fork we want the nudge to fire again instead of
   * staying spent for the rest of the run.
   */
  resetDecisionGateNudges(): void {
    this.decisionGateNudges = 0;
  }
  /** How many times the decision-gate nudge fired this run (0 or 1). */
  get decisionGateNudgeCount(): number {
    return this.decisionGateNudges;
  }
  /** Plan depth (simple|normal|complex) — drives depth-aware gating. */
  get planDepth(): string {
    return this.opts.planDepth ?? 'normal';
  }

  /** Marks the latest spec as approved so mutating tools become unblocked.
   *  `path` is the repo-relative location the runner persisted the body at. */
  approveSpec(path: string): void {
    this.specApproved = true;
    this.specPath = path;
  }

  /**
   * Reset the spec-approval flag. Mirror of `resetPlanApproval` for the
   * spec workflow — used by `setSessionAgent` when the agent transitions
   * INTO `spec` mode mid-session.
   */
  resetSpecApproval(): void {
    this.specApproved = false;
    this.specPath = null;
  }

  /** Whether the current spec has been approved. Mirror of `isPlanApproved` for spec mode. */
  isSpecApproved(): boolean {
    return this.specApproved;
  }

  /** Repo-relative path of the most recently approved spec, or null. */
  currentSpecPath(): string | null {
    return this.specPath;
  }

  /** True while the runner is operating under spec-mode discipline. */
  get specMode(): boolean {
    return Boolean(this.opts.specMode);
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
    if (this.pendingResolves.size > 0) {
      const payload = JSON.stringify({ aborted: true });
      const resolvers = Array.from(this.pendingResolves.values());
      this.pendingResolves.clear();
      for (const r of resolvers) r(payload);
    }
  }

  /**
   * Supervisor recovery (Phase 2.3) — unwedge a SINGLE stuck tool call without
   * terminating the run. Aborts the in-flight invocation matching `toolUseId`
   * and stashes `errorMessage`; the dispatch loop surfaces it as that call's
   * tool_result (is_error), so the model sees why and continues on the next
   * turn. Returns false (no-op) when the id isn't an in-flight call — the
   * supervisor's recovery action then falls back to `abort()`.
   */
  injectToolResultError(toolUseId: string, errorMessage: string): boolean {
    const ctl = this.inFlightTools.get(toolUseId);
    if (!ctl) return false;
    this.injectedToolErrors.set(toolUseId, errorMessage);
    try {
      ctl.abort();
    } catch {
      // Already settled — drop the stashed message so it can't leak onto a
      // later call that happens to reuse the id (ids are unique per turn, but
      // be defensive).
      this.injectedToolErrors.delete(toolUseId);
      return false;
    }
    return true;
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
  pushUserMessage(text: string, extras?: { selectedSkillIds?: string[] }): void {
    this.pendingUserMessages.push({ text, selectedSkillIds: extras?.selectedSkillIds });
    this.wakePendingMessageWaiters();
  }

  private wakePendingMessageWaiters(): void {
    const waiters = this.pendingMessageWaiters;
    this.pendingMessageWaiters = [];
    for (const w of waiters) { try { w(); } catch { /* ignore */ } }
  }

  /**
   * Resolve when a user message is queued (immediately if one already is), or
   * when `signal` aborts. Used by the background-job parking gate so a message
   * sent while the run is parked wakes it at once. Never rejects.
   */
  waitForPendingMessage(signal?: AbortSignal): Promise<void> {
    if (this.pendingUserMessages.length > 0 || signal?.aborted) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const done = () => {
        // Splice self out so an abort-resolved waiter doesn't linger in the
        // array until the next pushUserMessage (which would double-invoke it).
        const i = this.pendingMessageWaiters.indexOf(done);
        if (i >= 0) this.pendingMessageWaiters.splice(i, 1);
        signal?.removeEventListener('abort', done);
        resolve();
      };
      this.pendingMessageWaiters.push(done);
      signal?.addEventListener('abort', done, { once: true });
    });
  }

  /**
   * True when there are buffered user messages not yet flushed into a turn.
   * Lets callers (e.g. the company `wait_for_subordinates` loop) level-trigger
   * off the queue instead of relying solely on an edge signal that may have
   * been emitted while no listener was subscribed.
   */
  hasPendingUserMessages(): boolean {
    return this.pendingUserMessages.length > 0;
  }


  /** Append a user message with arbitrary content blocks (text + image + document). */
  pushUserContent(blocks: ContentBlock[], extras?: { selectedSkillIds?: string[] }): void {
    const msg: AgentMessage = { role: 'user', content: blocks };
    if (extras?.selectedSkillIds && extras.selectedSkillIds.length > 0) {
      msg.selectedSkillIds = extras.selectedSkillIds;
    }
    this.messages.push(msg);
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
   * Effective tool permission mode for the PermissionGate. NULL column /
   * unset option → 'auto'. Read live (closure in the gate deps) so
   * `setToolPermissionMode` applies to the very next gated tool call.
   */
  getToolPermissionMode(): 'ask' | 'auto' | 'unrestricted' {
    return this.opts.toolPermissionMode ?? 'auto';
  }

  /** Switch the tool permission mode mid-run (PATCH endpoint / worker RPC). */
  setToolPermissionMode(mode: 'ask' | 'auto' | 'unrestricted'): void {
    this.opts = { ...this.opts, toolPermissionMode: mode };
  }

  private async maybeAskAgentDecisionSwitch(): Promise<RunResult | null> {
    if (this.agentDecisionSwitchAsked) return null;
    if (this.opts.agentDecisionAskBeforeSwitch !== true) return null;
    const g = this.opts.agentDecisionGuidance;
    if (!g?.shouldAskBeforeAgentSwitch) return null;
    if (!this.opts.toolContext.setSessionAgent) return null;
    if (this.isSubagent) return null;
    if (g.recommendedAgent === 'admin' && !g.requiresExplicitUserIntent) return null;
    const current = g.currentAgent ?? this.opts.agentId ?? null;
    if (!current || current === g.recommendedAgent) return null;

    this.agentDecisionSwitchAsked = true;
    const id = `q_agent_switch_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const reason = g.agentSwitchReason ?? `${g.intent} work fits ${g.recommendedAgent} better than ${current}.`;
    this.emit('question_posted', {
      type: 'question',
      id,
      header: 'Agent suggestion',
      question: `This task looks better suited for the ${g.recommendedAgent} agent. Switch from ${current}?`,
      options: [
        { label: `Switch to ${g.recommendedAgent}`, value: 'switch_agent' },
        { label: `Stay on ${current}`, value: 'keep_current' },
      ],
      allowFreeform: false,
    } satisfies QuestionBlock);

    const raw = await this.waitForUserInput();
    let parsed: { answer?: string; aborted?: boolean; interrupted?: boolean };
    try { parsed = JSON.parse(raw); } catch { parsed = { answer: raw }; }
    if (parsed.aborted || parsed.interrupted) return null;
    if ((parsed.answer ?? raw) !== 'switch_agent') return null;

    this.opts.toolContext.setSessionAgent(g.recommendedAgent);
    this.appendSystemReminder(
      `Agent switched to ${g.recommendedAgent} after user approval. Reason: ${reason}. ` +
      `Restart or continue this session so the next run is built with the new agent prompt/tool profile.`,
    );
    return this.finishWith(
      {
        input_tokens: 0,
        output_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
      'completed',
    );
  }

  /**
   * Delegate to the Behavior Tree orchestrator. Bridges the legacy
   * `EventEmitter` interface to the BT's typed `emit` callback so listeners
   * attached to this runner (CLI/SSE) continue to receive every event
   * (`turn_start`, `text_delta`, `tool_call_result`, …) regardless of which
   * runtime executed the turn.
   *
   * Also wires the `BridgeCallbacks` so the BT delegates features still
   * owned by this class: skills, active-context, quality-feedback suffix,
   * temperature resolution, Responses-API state, plan/spec gates.
   */
  private async runViaBehaviorTree(): Promise<RunResult> {
    const switchResult = await this.maybeAskAgentDecisionSwitch();
    if (switchResult) return switchResult;
    console.log(
      `[coder/bt] runViaBehaviorTree session=${this.sessionId ?? '-'} ` +
      `provider=${this.opts.provider.name} model=${this.opts.provider.model} ` +
      `tiers=${this.activeTiers ? Array.from(this.activeTiers).sort().join(',') : '*'} ` +
      `messages=${this.messages.length}`,
    );
    // Pass tiers through unchanged — null means "no filter" so MCP-external
    // tools and subagent registries don't get accidentally pruned. Both the
    // tier Set and the pin Set are shared BY REFERENCE so `promoteTier()` /
    // dispatch-time pins reach the next turn's buildTools.
    const initialTiers = this.activeTiers ?? null;
    return runBehaviorTree({
      opts: this.opts,
      emit: ((event: string, ...args: unknown[]) => {
        // Mirror the loop-local turn (RunContext.turn) into the public field
        // (see the `turn` docstring) so Quality v2 turn-accounting
        // (nudge/classify/backfill/dedup/holdout) isn't frozen at 0. Every
        // `turn_start` flows through here for both the main runner and
        // subagents, so this is the single point that keeps the mirror live.
        if (event === 'turn_start' && typeof args[0] === 'number') this.turn = args[0];
        (this as unknown as { emit: (e: string, ...a: unknown[]) => boolean }).emit(event, ...args);
      }) as never,
      initialTiers,
      initialPins: this.pinnedTools,
      // Share the live messages array so `pushUserContent` / system reminders
      // / BT pushes all see the same backing store.
      initialMessages: this.messages,
      bridge: {
        buildActiveSkillsBlock: (history) => this.buildActiveSkillsBlockForLastUser(history),
        buildActiveContextBlock: () =>
          this.opts.agentLoopV2 ? this.buildActiveContextBlockForTurn() : null,
        buildQualityFeedbackSuffix: () => this.buildQualityFeedbackSuffix(),
        getRelevantProjectMemory: this.opts.getRelevantProjectMemory,
        synthesizeMemoryQuery: this.opts.synthesizeMemoryQuery,
        getSessionStateData: this.opts.getSessionStateData,
        // A1 — independent goal-completion verifier (host-built; undefined when off).
        verifyGoalCompletion: this.opts.verifyGoalCompletion,
        getProjectMemoryIndex: this.opts.getProjectMemoryIndex,
        // Session-drive "guide files": surface the files this session has
        // edited so the dynamic injector can remind the model (the injector
        // dedups, so each file is announced once). Was a dead hook until now.
        collectDynamicInjectionSignals: () => {
          const recentlyEditedFiles = this.recentEditedFilesForInjection();
          if (recentlyEditedFiles.length === 0) return null;
          return { newlyRegisteredSkillIds: [], recentlyEditedFiles };
        },
        resolveTemperature: () => {
          const r = resolveTemperature({
            agent: this.opts.agentId ?? null,
            providerName: this.opts.provider.name,
            model: this.opts.provider.model,
            thinking: !!this.opts.thinking,
            sessionOverride: this.opts.sessionTemperature ?? null,
            roleOverride: this.opts.roleTemperature ?? null,
          });
          if (typeof r.temperature !== 'number') return null;
          return { temperature: r.temperature, source: r.source };
        },
        getPreviousResponseId: () =>
          this.previousResponseId
            ? { id: this.previousResponseId, messageCount: this.previousResponseMessageCount ?? 0 }
            : null,
        onResponseId: (id, messageCount) => {
          this.previousResponseId = id;
          this.previousResponseMessageCount = messageCount;
          this.opts.onResponseId?.(id, messageCount);
        },
        isPlanApproved: () => this.isPlanApproved(),
        toolGate: (toolName, _input) => {
          // Plan/spec gates: mutating tools blocked until the user approves
          // the plan/spec. The detailed wording mirrors the legacy refusal
          // shape — `runner.ts` legacy path has richer rejection text; the
          // BT minimal path here keeps it short and explicit.
          //
          // Critical: the gate MUST respect `planApproved` / `specApproved`,
          // otherwise `runner.approvePlan()` (called by submit_plan after
          // user approval) does nothing and every mutating tool gets
          // refused even though the user said "go". This was a regression
          // when the BT bridge replaced the legacy `invokeToolWithGuards`
          // path — that one consulted the approval flags; the bridge
          // version originally checked only `planMode`/`specMode`.
          const tool = this.findTool(toolName);
          if (!tool) return null;
          const mutates = tool.mutates ?? (tool.source === 'mcp_external');
          // Execution-intent workflow verbs (execute_tasks) reach their
          // handler even unapproved in PLAN mode — the handler runs the
          // human-gated plan→build transition instead of mutating directly.
          // Spec mode stays strict (the handler has no spec→build path), so
          // execute_tasks remains gated there. Shared predicate keeps this in
          // sync with policy.ts. See isPlanModeWorkflowTool.
          const planWorkflowExempt = isPlanModeWorkflowTool(toolName);
          if (this.opts.planMode && !this.planApproved && mutates && !planWorkflowExempt) {
            return '[plan-mode: mutating tool blocked. Call `submit_plan` first; tools unlock after approval.]';
          }
          if (this.opts.specMode && !this.specApproved && mutates) {
            return '[spec-mode: mutating tool blocked. Call `submit_spec` first; tools unlock after approval.]';
          }
          const softGuard = evaluateSoftAgentDecisionGuardrail(tool, {
            enabled: this.opts.agentDecisionSoftGuardrail === true,
            guidance: this.opts.agentDecisionGuidance,
            minConfidence: this.opts.agentDecisionSoftGuardrailMinConfidence,
          });
          if (!softGuard.allowed) return softGuard.detail;
          return null;
        },
        enforcePreRead: (toolName, input, turn, toolUseId) =>
          this.enforcePreReadForBridge(toolName, input, turn, toolUseId),
        registerInFlightTool: (toolUseId, ctl) => { this.inFlightTools.set(toolUseId, ctl); },
        unregisterInFlightTool: (toolUseId) => {
          this.inFlightTools.delete(toolUseId);
          // Drop any stashed inject message the dispatch loop didn't consume —
          // e.g. the tool resolved in the same tick the supervisor aborted, so
          // the abort branch never ran. Prevents an unbounded map leak.
          this.injectedToolErrors.delete(toolUseId);
        },
        consumeInjectedToolError: (toolUseId) => {
          const msg = this.injectedToolErrors.get(toolUseId);
          if (msg !== undefined) this.injectedToolErrors.delete(toolUseId);
          return msg;
        },
        postProcessToolResult: (result) => this.postProcessToolResultForBridge(result),
        enforceTaskMode: (toolName, toolMutates) => {
          // Pure guard — reads the persisted tasks state and decides. Same
          // family as enforcePreRead but specific to the `submit_tasks` →
          // `execute_task` workflow.
          const tasksState = this.opts.toolContext.getTasksState?.() ?? null;
          if (!tasksState) return null;
          return checkTaskModeGate({
            tasksState: {
              approved: tasksState.approved,
              execution_mode: tasksState.execution_mode,
              tasks: tasksState.tasks.map((t) => ({ id: t.id, status: t.status })),
            },
            toolName,
            toolMutates,
          });
        },
        reduceToolResult: (toolName, content) =>
          applySmartReducer(toolName, content, this.effectivePushTimeCap, {
            query: this.getLastUserText(),
          }),
        finalizeToolResult: (a) => this.finalizeToolResultForBridge(a),
        detectPollingStuck: (toolName, content, isError, isRepeatable, turn) =>
          this.detectPollingStuckForBridge(toolName, content, isError, isRepeatable, turn),
        runQualityCheck: ({ turn, assistantText, toolResults }) => {
          // Mirror the legacy recordToolCallsForWatchdog + maybeRunWatchdog
          // pipeline. recordToolCallsForWatchdog updates the rolling
          // window (60 names + calls); maybeRunWatchdog fires the LLM
          // classifier asynchronously when the pre-filter says the
          // pattern is suspicious AND the cooldown has elapsed.
          if (toolResults.length > 0) {
            const blocks = toolResults.map((r) => ({
              name: r.name,
              input: (r.input ?? {}) as Record<string, unknown>,
            }));
            const isErrorPerBlock = toolResults.map((r) => r.isError);
            this.recordToolCallsForWatchdog(turn, blocks, isErrorPerBlock);
          }
          this.maybeRunWatchdog(turn, assistantText);
        },
        // Drain queued user messages at the top of every Executing turn.
        // Without this, messages pushed by `runner.pushUserMessage`
        // (master forwards, SSE push from the dashboard) accumulate in
        // `pendingUserMessages` forever — the legacy loop drained at the
        // same boundary; the BT now delegates back here so the queue's
        // ownership stays on the runner class.
        flushPendingMessages: () => this.flushPendingMessages(),
        // Loop-enforcement steering — the Executing node calls this when a
        // tool+args got refused across multiple planning cycles. Wraps
        // `pushUserMessage` so the reminder lands at the next turn (after the
        // ToolLoopDetected → Planning hop) via the same drain as above.
        injectSystemReminder: (text: string) => this.pushUserMessage(text),
        // Background (fire-and-forget) subagent liveness. Main runner only —
        // subagents/company masters never create ephemeral background jobs, so
        // `hasActive()` is false there and the orchestrator never parks.
        backgroundJobs: this.isSubagent || this.sessionId == null ? undefined : {
          hasActive: () => getSubagentJobManager().hasActiveJobs(this.sessionId!),
          park: (signal: AbortSignal) => parkForBackgroundWork({
            manager: getSubagentJobManager(),
            sessionId: this.sessionId!,
            signal,
            capMs: Number(process.env.CODER_BACKGROUND_PARK_CAP_MS ?? 30 * 60_000) || 30 * 60_000,
            waitForMessage: (s) => this.waitForPendingMessage(s),
            hasPendingMessage: () => this.hasPendingUserMessages(),
            pushNotice: (text) => this.pushUserMessage(text),
            persistNotice: (text) => {
              if (this.opts.sessionStore && this.sessionId != null) {
                try { this.opts.sessionStore.appendMessage(this.sessionId, { role: 'user', content: [{ type: 'text', text }], isMeta: true }); } catch { /* best-effort */ }
              }
            },
          }),
        },
        // Per-turn telemetry persistence. The pure insert lives in
        // `core/runner/telemetry/persist-turn.ts`; the class-bound
        // side-effects (quality classifier dispatch + tool-selection
        // observer) stay here because they read `this.messages`,
        // `this.pendingClassifyByTurn`, etc. The wrapper also mirrors
        // the inserted id into `this.lastTurnTelemetryId` so the host's
        // `flushPendingTurn` in `index.ts` (which reads
        // `runner.lastTurnTelemetryId`) keeps working unchanged.
        persistTurnTelemetry: (input) => this.persistTurnTelemetryWrapper(input),
      },
    });
  }

  /**
   * Move every message buffered by `pushUserMessage` into the live
   * history. Called at the top of every Executing turn via the BT
   * bridge — never directly from outside the class. Idempotent (a
   * second call on an empty queue is a no-op).
   */
  private flushPendingMessages(): void {
    while (this.pendingUserMessages.length > 0) {
      const pending = this.pendingUserMessages.shift()!;
      const msg: AgentMessage = {
        role: 'user',
        content: [{ type: 'text', text: pending.text }],
      };
      if (pending.selectedSkillIds && pending.selectedSkillIds.length > 0) {
        msg.selectedSkillIds = pending.selectedSkillIds;
      }
      this.messages.push(msg);
    }
  }

  /**
   * Class-bound wrapper around `persistTurnTelemetryPure`. Owns the
   * three side-effects that need access to instance state:
   *   1. Stores the inserted id on `this.lastTurnTelemetryId` so
   *      `index.ts`'s `flushPendingTurn` can stamp the tool_call rows.
   *   2. Feeds the global ToolSelection observer (FeedbackCollector
   *      backfill).
   *   3. Dispatches the quality classifier (adaptive sampling, v2
   *      promise tracked so the next turn's nudge can await it).
   *
   * Errors are swallowed at every layer — telemetry never breaks a real
   * turn. The pure helper already wraps its DB write in `try`; the
   * observer + classifier blocks have their own `try/catch`.
   */
  private persistTurnTelemetryWrapper(input: {
    turn: number;
    usage: ChatUsage | null;
    toolUseBlocks: ReadonlyArray<ToolUseBlock>;
    toolResultBlocks: ReadonlyArray<ContentBlock>;
    historyChars: number;
    systemPromptChars: number;
    toolsDefChars: number;
    visibleToolsCount?: number;
    toolsFingerprint?: string | null;
    prefixHeadHash?: string | null;
    reducerStats?: { retired: number; freedChars: number; pendingRetired: number; pendingChars: number } | null;
    responseMeta: ChatProviderResponseMeta | null;
    compactionTriggered: boolean;
    summarizerRan: boolean;
  }): number | null {
    const id = persistTurnTelemetryPure({
      store: this.sessionStore,
      sessionId: this.sessionId ?? null,
      runId: this.runId,
      isSubagent: this.isSubagent,
      provider: this.opts.provider.name ?? null,
      model: this.opts.provider.model ?? null,
      turn: input.turn,
      usage: input.usage,
      toolUseBlocks: input.toolUseBlocks,
      toolResultBlocks: input.toolResultBlocks,
      historyChars: input.historyChars,
      compactionTriggered: input.compactionTriggered,
      summarizerRan: input.summarizerRan,
      systemPromptChars: input.systemPromptChars,
      toolsDefChars: input.toolsDefChars,
      visibleToolsCount: input.visibleToolsCount,
      toolsFingerprint: input.toolsFingerprint,
      prefixHeadHash: input.prefixHeadHash,
      reducerStats: input.reducerStats,
      responseMeta: input.responseMeta,
      agentDecisionTelemetry: this.opts.agentDecisionTelemetry,
      actualAgent: this.opts.agentId ?? null,
    });
    this.lastTurnTelemetryId = id;

    // Tool-selection feedback observer — only needs the user's task
    // text + tool names. No-op when no observer is installed.
    let lastUserText = '';
    try {
      for (let i = this.messages.length - 1; i >= 0; i--) {
        const m = this.messages[i];
        if (m.role === 'user') {
          lastUserText = typeof m.content === 'string'
            ? m.content
            : m.content.map((b) => (b.type === 'text' ? b.text : '')).join(' ');
          break;
        }
      }
      const observer = getGlobalToolSelectionOutcomeObserver();
      if (observer && input.toolUseBlocks.length > 0 && lastUserText) {
        observer(lastUserText, input.toolUseBlocks.map((b) => b.name));
      }
    } catch {
      // Observer failures must never break telemetry.
    }

    // Adaptive quality classifier dispatch (v2). The Promise stays in
    // `pendingClassifyByTurn` so the NEXT turn's nudge builder can race
    // it with a 2s timeout — closes the v1 race where the next prompt
    // was assembled before the prior verdict landed.
    if (isGlobalQualityClassifierEnabled() && lastUserText && this.sessionId != null) {
      try {
        const lastAssistantText = this.extractLastAssistantText();
        const hasNarrative = lastAssistantText.length > 0;
        const lastWorst = this.peekLastSessionWorstVerdict();
        const shouldClassify = shouldClassifyTurn({
          turn: input.turn,
          sessionId: this.sessionId,
          hasNarrativeText: hasNarrative,
          lastWorstVerdict: lastWorst,
        });
        if (shouldClassify) {
          // Snapshot the identifiers into locals — `this` may have been
          // recycled by the next turn when the Promise resolves.
          const snapshotSessionId = this.sessionId;
          const snapshotCompanySessionId = this.opts.companySessionId ?? null;
          const snapshotAgentRunId = this.opts.companyAgentRunId ?? null;
          const snapshotTurn = input.turn;
          const promise = new Promise<QualityResult | null>((resolve) => {
            setImmediate(() => {
              runGlobalQualityClassifiers({
                sessionId: snapshotSessionId,
                companySessionId: snapshotCompanySessionId,
                agentRunId: snapshotAgentRunId,
                messageId: `turn-${snapshotTurn}`,
                taskText: lastUserText,
                outputText: lastAssistantText,
                recentToolCalls: input.toolUseBlocks.map((b) => ({
                  name: b.name,
                  success: true,
                  timestampMs: Date.now(),
                })),
              }).then(resolve).catch(() => resolve(null));
            });
          });
          this.pendingClassifyByTurn.set(snapshotTurn, promise);
          // Auto-trim — only the immediately prior turn's Promise is
          // ever awaited; older entries are dead weight.
          for (const [t] of this.pendingClassifyByTurn) {
            if (t < snapshotTurn - 3) this.pendingClassifyByTurn.delete(t);
          }
        }
      } catch {
        // Classifier failures must never break the run.
      }
    }

    return id;
  }

  /**
   * Pre-read enforcement for the BT bridge. Mirrors the legacy runner path,
   * including the important mutation-aware escape hatch: if a file was edited
   * after the prior read, the reread is allowed and post-processed into a
   * small diff instead of being refused as "already in context".
   */
  private enforcePreReadForBridge(
    toolName: string,
    input: unknown,
    turn: number,
    toolUseId: string,
  ): string | { content: string; isError?: boolean } | null {
    if (!this.opts.agentLoopV2) return null;
    if (!REDUCIBLE_READ_TOOLS.has(toolName)) return null;
    const inp = input as Record<string, unknown> | undefined;
    const path = getStringField(inp, 'path', 'file_path');
    if (!path) return null;
    if (inp?.force_reread === true) {
      this.setTransition('pre-read-force-reread');
      return null;
    }
    const readKey = `${toolName}|${buildReadDedupKey(path, inp)}`;
    const threshold = readDupThreshold();
    const window = readDupWindow();
    const minTurn = turn - window;
    const prior = (this.recentReadKeys.get(readKey) ?? []).filter((e) => e.turn > minTurn);
    prior.push({ turn, useId: toolUseId });
    this.recentReadKeys.set(readKey, prior);
    if (threshold >= 1 && prior.length >= threshold) {
      const oldestPrior = prior[0];
      const mutationTurn = lastMutationTurn(path, this.recentWrites, oldestPrior.turn);
      if (mutationTurn != null) {
        this.pendingDiffRereads.set(toolUseId, {
          priorUseId: oldestPrior.useId,
          priorTurn: oldestPrior.turn,
          path,
        });
        this.setTransition('pre-read-allowed-mutation');
        return null;
      }

      if (allPriorReadsElided(prior.slice(0, -1), this.messages)) {
        this.setTransition('pre-read-allowed-elided');
        return null;
      }

      if (readAutoDowngradeEnabled()) {
        this.setTransition('pre-read-auto-downgraded');
        const content = buildAutoDowngradeResponse(toolName, path, prior, window, this.messages);
        // The downgrade delivered a POINTER, not content — keep the ledger
        // honest (only calls that put content into context count as reads).
        prior.pop();
        return { content, isError: false };
      }

      const firstPrior = prior.find((p) => p !== prior[prior.length - 1]) ?? prior[0];
      const priorResult = findToolResultByUseId(firstPrior.useId, this.messages);
      const preview = priorResult && !priorResult.isElided
        ? extractReadPreview(priorResult.content)
        : undefined;
      let currentMtimeMs: number | undefined;
      try {
        currentMtimeMs = fsStatSync(pathResolve(this.opts.toolContext.cwd, path)).mtimeMs;
      } catch {
        /* path may not exist anymore */
      }
      this.setTransition('pre-read-blocked');
      const refusal = buildRichRefusal({
        toolName,
        path,
        prior: prior.slice(0, -1),
        windowTurns: window,
        currentMtimeMs,
        // Drives the refusal wording: present → "content is in your context";
        // absent (prior reads elided/compacted) → honest force_reread pointer.
        contextPreview: preview,
      });
      // A refused attempt never delivered content — drop it from the ledger
      // so refusals can't compound into more "prior reads".
      prior.pop();
      return refusal;
    }
    return null;
  }

  /**
   * Remove a read attempt from the pre-read ledger after it FAILED. The
   * ledger entry is pushed optimistically in `enforcePreReadForBridge`
   * (before dispatch); only reads that actually delivered content may count
   * toward the re-read threshold.
   */
  private dropFailedReadFromLedger(
    toolName: string,
    input: Record<string, unknown>,
    toolUseId: string,
  ): void {
    if (!REDUCIBLE_READ_TOOLS.has(toolName)) return;
    const path = getStringField(input, 'path', 'file_path');
    if (!path) return;
    const readKey = `${toolName}|${buildReadDedupKey(path, input)}`;
    const list = this.recentReadKeys.get(readKey);
    if (!list) return;
    const idx = list.findIndex((e) => e.useId === toolUseId);
    if (idx >= 0) list.splice(idx, 1);
  }

  /**
   * Live final shaping for a tool result: spill the RAW pre-reduction original
   * to the side-file store (so reductions + truncations are recoverable via
   * `get_tool_output`) and apply the generic fail-safe cap with an output_id
   * marker. Mirrors the resume-time `normalizeMessageForCache` cap so live and
   * resumed histories stay byte-identical. No-op spill when there's no store
   * (subagents / tests) — the fail-safe cap still applies.
   */
  private finalizeToolResultForBridge(args: {
    toolName: string;
    rawContent: string;
    shapedContent: string;
    isError: boolean;
  }): { content: string; truncated?: boolean; originalSize?: number } {
    // P3 — clamp the user's cap with a context-relative ceiling so a single
    // tool_result can't exceed the protected tail and deadlock compaction
    // (`compact_exhausted`). `Infinity` ceiling (knob off) → user cap only.
    // Resolved from the CURRENT provider model so it tracks `swapProvider`.
    const cap = resolveFinalizeCap(this.effectivePushTimeCap, this.opts.provider.model);
    return finalizeToolOutput({
      rawContent: args.rawContent,
      shapedContent: args.shapedContent,
      isError: args.isError,
      cap,
      store: this.opts.toolContext.toolOutputStore,
    });
  }

  private postProcessToolResultForBridge(args: {
    toolUseId: string;
    name: string;
    input: Record<string, unknown>;
    rawContent: string;
    content: string;
    isError: boolean;
    turn: number;
  }): { content: string; isError?: boolean } | null {
    if (!this.opts.agentLoopV2) return null;
    if (args.isError) {
      // A FAILED read delivered nothing into context — remove the entry that
      // enforcePreRead optimistically pushed, or the guard later refuses a
      // retry claiming "content is already in your context above" (observed:
      // two empty-path read_file failures followed by a refusal citing them).
      this.dropFailedReadFromLedger(args.name, args.input, args.toolUseId);
      return null;
    }

    let nextContent = args.content;
    let changed = false;

    if (REDUCIBLE_READ_TOOLS.has(args.name)) {
      const path = getStringField(args.input, 'path', 'file_path');
      if (path) {
        const readKey = `${args.name}|${buildReadDedupKey(path, args.input)}`;
        const list = this.recentReadKeys.get(readKey);
        if (list && list.length > 0) {
          const tail = list[list.length - 1];
          if (tail.useId === args.toolUseId) {
            tail.contentHash = createHash('sha1').update(args.rawContent).digest('hex');
            try {
              tail.mtimeMs = fsStatSync(pathResolve(this.opts.toolContext.cwd, path)).mtimeMs;
            } catch {
              /* file may not exist */
            }
          }
        }
      }

      const pending = this.pendingDiffRereads.get(args.toolUseId);
      if (pending) {
        this.pendingDiffRereads.delete(args.toolUseId);
        const priorResult = findToolResultByUseId(pending.priorUseId, this.messages);
        if (priorResult && !priorResult.isElided) {
          const diff = buildSimpleLineDiff(priorResult.content, args.rawContent, 3);
          nextContent =
            `[reread-after-edit] \`${pending.path}\` was mutated since your prior read at turn ${pending.priorTurn}. ` +
            `Returning unified diff against that read (pass force_reread=true to bypass diff and get full content).\n\n` +
            diff;
        } else {
          nextContent =
            `[reread-after-edit] \`${pending.path}\` was mutated since your prior read at turn ${pending.priorTurn}, ` +
            `but that prior read has been compacted from your context. Returning full current content below.\n\n` +
            nextContent;
        }
        changed = true;
      }
    }

    if (isMutatingFsTool(args.name)) {
      if (args.name === 'apply_patch') {
        const raw =
          typeof args.input.patch === 'string' ? args.input.patch :
          typeof args.input._raw === 'string' ? args.input._raw :
          '';
        for (const m of raw.matchAll(/\*\*\* (?:Update|Add|Delete) File:\s*(.+)$/gm)) {
          this.recentWrites.set(m[1].trim(), args.turn);
        }
      } else {
        const path = getStringField(args.input, 'path', 'file_path');
        if (path) this.recentWrites.set(path, args.turn);
      }
    }

    return changed ? { content: nextContent } : null;
  }

  /**
   * Polling-stuck detector for the BT bridge. Tracks the most-recent
   * content hash per polling tool and refuses on the Nth identical run.
   * Uses the same `pollingResultRun` map as the legacy loop, so both
   * paths share state — switching between BT and legacy mid-session
   * doesn't reset the counter.
   */
  private detectPollingStuckForBridge(
    toolName: string,
    content: string,
    isError: boolean,
    isRepeatable: boolean,
    turn: number,
  ): string | null {
    if (!isRepeatable || isError) return null;
    // Preview/DevTools tools are exempt: their RESULT content is intentionally
    // fixed ("Captured the preview…") while the real payload (the screenshot
    // image, evolving console/network) is out-of-band or genuinely changes
    // across navigations — so byte-identical content is NOT a stuck poll. These
    // are deliberate, agent-driven debugging calls (not background polling); the
    // run's maxTurns is the backstop against a genuine runaway.
    if (PREVIEW_TOOLS.has(toolName)) return null;
    if (POLLING_STUCK_CAP < 2) return null;
    if (content.length < POLLING_STUCK_MIN_CHARS) return null;
    const rHash = createHash('sha1').update(content).digest('hex');
    const prev = this.pollingResultRun.get(toolName);
    const next = prev && prev.hash === rHash
      ? { hash: rHash, count: prev.count + 1, firstTurn: prev.firstTurn }
      : { hash: rHash, count: 1, firstTurn: turn };
    this.pollingResultRun.set(toolName, next);
    if (next.count >= POLLING_STUCK_CAP) {
      this.pollingResultRun.delete(toolName);
      this.setTransition('dup-call-cap');
      console.warn(
        `[coder] polling-stuck refusal (BT): ${toolName} same result ${next.count}× — refused at turn ${turn}`,
      );
      return buildPollingStuckRefusal({
        toolName,
        count: next.count,
        firstTurn: next.firstTurn,
      });
    }
    return null;
  }

  /** Lookup helper for the toolGate bridge. */
  private findTool(name: string): import('@mcp/code-agent/core/tool.js').CoderTool | null {
    try {
      for (const t of this.opts.registry.list()) {
        if (t.name === name) return t;
      }
    } catch {
      /* defensive */
    }
    return null;
  }

  /**
   * Latest user-turn prose, used to rank generic tool-output rows by relevance
   * (see applySmartReducer → json-crush). Skips injected context blocks
   * (system-reminder / active-context) which start with '<', and caps length so
   * the relevance tokenizer stays cheap. Empty string when there's no user turn.
   */
  private getLastUserText(): string {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const m = this.messages[i];
      if (m.role !== 'user') continue;
      const text = typeof m.content === 'string'
        ? m.content
        : m.content
            .map((b) => (b.type === 'text' && !b.text.trimStart().startsWith('<') ? b.text : ''))
            .join(' ');
      return text.slice(0, 4000);
    }
    return '';
  }

  /**
   * Run the loop until completion. Delegates to the Behavior Tree
   * orchestrator unconditionally. The legacy while-loop was removed in
   * the post-Frente-E sweep; if the BT throws, the throw propagates to
   * the caller (worker / SSE handler) which has its own recovery path.
   *
   * Helpers on this class that used to be called by the legacy loop
   * remain ONLY when they are also called by the BT bridge — anything
   * exclusively-legacy was removed.
   */
  async run(): Promise<RunResult> {
    return this.runViaBehaviorTree();
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
  push((args as { from_path?: unknown }).from_path);
  push((args as { to_path?: unknown }).to_path);
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

/**
 * Parse `CODER_NUDGE_HOLDOUT_RATE` into a probability in [0, 1].
 * Unset → 0.15 (held-out counterfactual on by default). Explicit 0,
 * negative, or non-numeric → 0 (disabled — every qualifying nudge is sent).
 * Values above 1 are clamped to 1.
 */
function parseNudgeHoldoutRate(raw: string | undefined): number {
  if (raw === undefined || raw === '') return 0.15;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(1, n);
}
