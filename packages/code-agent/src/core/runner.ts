export { compactHistoryForLLM } from './runner/assembly/compact-history.js';
import { EventEmitter } from 'node:events';
import { randomUUID, createHash } from 'node:crypto';
import { resolve as pathResolve, relative as pathRelative, isAbsolute } from 'node:path';
import { statSync as fsStatSync } from 'node:fs';
import type { ChatProvider } from '@mcp/code-agent/providers/adapter.js';
import type {
  AgentMessage,
  ChatProviderResponseMeta,
  ChatUsage,
  ContentBlock,
  ToolUseBlock,
  QuestionBlock,
  ToolResultBlock,
} from '@mcp/code-agent/core/messages.js';
// Post-legacy-removal: only the helpers still consumed by
// `compactHistoryForLLM` (re-exported below) and the BT bridge
// (`enforcePreReadForBridge`, `postProcessToolResultForBridge`) remain.
// The char-based compaction, sliding-window, deriveCompactionLimits,
// isNewCompactionEnabled, postCompactCleanup, cutoff helpers — all
// dead, all dropped from the import surface.
import {
  REDUCIBLE_READ_TOOLS,
  buildReadDedupKey,
  getStringField,
  isMutatingFsTool,
  allPriorReadsElided,
  lastMutationTurn,
  findToolResultByUseId,
  buildSimpleLineDiff,
} from "@mcp/code-agent/core/compaction.js";
import {
  evaluateSoftAgentDecisionGuardrail,
  evaluateToolInvocation,
  findScopeViolations,
} from '@mcp/code-agent/core/policy.js';
import {
  ReadCoverageLedger,
  readCoverageEnabled,
  parseServedRange,
  buildCoveragePointer,
  requestsFreshRead,
  rereadAfterEditHeader,
  visibleSpanOf,
} from '@mcp/code-agent/core/runner/guards/read-coverage.js';
import { type CoderTunables, envTunables } from '@mcp/code-agent/core/tunables.js';
import { isReadOnlyAgent } from '@mcp/code-agent/agents/index.js';
import { SessionFileKnowledge } from '@mcp/code-agent/tools/file-knowledge.js';
import { profileToTiers, PREVIEW_TOOLS, type ToolTier } from '@mcp/code-agent/tools/tiers.js';
import { approvedPlanForRevision } from '@mcp/code-agent/tools/plan.js';
import { applySmartReducerDetailed, type ReductionReport } from '@mcp/code-agent/core/smart-reducers.js';
import {
  resolveRegisteredToolOutputPolicy,
  type ResolvedToolOutputPolicy,
} from '@mcp/code-agent/core/tool-output-policy.js';
import { ToolCallLedger } from '@mcp/code-agent/core/tool-call-ledger.js';
import { asSessionId } from '@mcp/session-storage';
import { resolveTemperature } from '@mcp/code-agent/inference/temperature.js';
import { buildActiveContextBlock } from '@mcp/code-agent/core/active-context.js';
import {
  type TodoItem,
  buildTrackState,
  deriveTodosFromState,
} from '@mcp/code-agent/tools/task-list-shared.js';
import { buildIndexedDocsBlock } from '@mcp/code-agent/core/docs-hint.js';
import { interpolateSkillVars } from '@mcp/code-agent/skills/prompt-injector.js';
import type { SkillTemplateContext } from '@mcp/code-agent/skills/types.js';

// Public types extracted to './runner/types.ts' (W4.2 split — keep this
// file under 250 LOC ceiling). Re-exported below so external consumers
// (`from './runner.js'`) keep their import paths unchanged.
import type {
  CompactionCheckpoint,
  RunResult,
  RunnerOptions,
  StopReason,
  TransitionKind,
} from './runner/types.js';
export type { CompactionCheckpoint, RunResult, RunnerOptions, StopReason, TransitionKind };

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
const PUSH_TIME_CAP = 24_000;
/** Tighter per-block cap used inside subagents — they accumulate many small
 *  tool results in a short window, so a 12k cap fits ~10 turns under the budget. */
const SUBAGENT_PUSH_TIME_CAP = 12_000;
// (POLLING_STUCK_* lives in './runner/constants.ts'.)
// Post-legacy-removal: only constants actively consumed by the BT
// bridge / `buildToolResultBlock` / re-exports survive. Legacy global
// duplicate-call/result knobs were removed with their unused consumers.
import {
  POLLING_STUCK_CAP,
  POLLING_STUCK_MIN_CHARS,
} from './runner/constants.js';

// (Pre-class helpers + tunable constants extracted to ./runner/* sub-modules —
// see the import block above. The corresponding doc-blocks live in those files.)
import {
  capFor,
  type ToolOutputCapLevel,
} from './runner/output-caps.js';
import { batchBudgetUnits } from './batch-return-format.js';

// Assembly modules — extracted in Commit 2 of the BT refactor. The legacy
// closures/methods below delegate to these so the BT's Executing node can
// reuse them once Commit 3 lands. Byte-identical to the legacy bodies.

// Behavior Tree orchestrator — the SOLE execution path post-Frente-E.
// The legacy while-loop (formerly ~2400 LOC inside `run()`) was removed;
// `run()` now does a one-line delegation to `runViaBehaviorTree`, which
// builds the BridgeCallbacks and hands off to `runBehaviorTree`.
import { runBehaviorTree } from './runner/orchestrator.js';
// Pure per-turn telemetry insert. Wrapped by `persistTurnTelemetryWrapper`
// below and exposed to the BT via `BridgeCallbacks`.
import { persistTurnTelemetry as persistTurnTelemetryPure } from './runner/telemetry/persist-turn.js';
import { checkTaskModeGate } from './runner/guards/task-mode-gate.js';

// Result-dedup markers and polling call-count caps belonged only to the removed
// legacy loop. The active BT retains result-aware polling-stuck detection.
import { buildPollingStuckRefusal } from './runner/markers.js';
export { buildPollingStuckRefusal };

// (previewToolArgs / stableArgsKey / readDupThreshold / readDupWindow /
// read helpers moved to './runner/dup-utils.ts'.)
import {
  stableArgsKey,
  readDupThreshold,
  readDupWindow,
} from './runner/dup-utils.js';
export { stableArgsKey };

// (Recovery circuit-breaker config + transient-retry tunables moved to
// './runner/recovery-config.ts'. Post-legacy-removal: only the symbols
// still consumed by `runViaBehaviorTree` / persistence / the BT bridge
// stay imported here — `preserveLastNTurns`, `transientRetry*` etc. were
// dead code paths from the legacy loop.)

// (nonRetryableProviderErrorReason + backoffDelayMs moved to './runner/provider-retry.ts'.)
import {
  backoffDelayMs,
} from './runner/provider-retry.js';
export { backoffDelayMs };

// Cycle-aware dominance guard (Fix G — session 609's 50+ silent turns of
// `mcp__read_file`) is now implemented in `runner/guards/dominance.ts` and
// wired by the Executing node via `evaluatePerTurnLoops`. Its fixed window and
// ratio (8 turns / 0.75) live in `runner/constants.ts`
// (dominanceWindow/dominanceRatio). The dead consts that used to sit here
// were never read — the guard had no implementation until P0.
// Post-legacy-removal: the auto-continue cap lives entirely inside the
// BT's `MaxTurnsGuard` (`runner/guards/max-turns.ts:maxAutoContinues`).
// The duplicated `MAX_AUTO_CONTINUES` constant that used to drive the
// legacy while-loop and the process-wide env override are gone. Filesystem
// session state is now the only authority for top-level run limits.

const PRESERVED_TOOL_OUTPUT_CAP = 200_000;


// (approxChars moved to './runner/pure-helpers.ts'.)
import {
  approxChars,
  capToolContent,
  finalizeToolOutput,
} from './runner/pure-helpers.js';
export { approxChars, capToolContent };
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
  return normalizeMessageForCacheWithPreservedIds(m, cap);
}

function normalizeMessageForCacheWithPreservedIds(
  m: AgentMessage,
  cap: number = PUSH_TIME_CAP,
  preservedToolUseIds?: ReadonlySet<string>,
  toolNamesByUseId?: ReadonlyMap<string, string>,
  resolveOutput?: (toolName: string, content?: string) => { policy: ResolvedToolOutputPolicy; cap: number },
  store?: { put(content: string): string | null },
): AgentMessage {
  if (m.role !== 'tool' && m.role !== 'user') return m;
  let mutated = false;
  const content = m.content.map((b): ContentBlock => {
    if (b.type !== 'tool_result') return b;
    const toolName = toolNamesByUseId?.get(b.tool_use_id);
    // Content-derived budgets (batched code_exec blocks) must resolve the same
    // cap on resume as they did live, or the cached prefix would change.
    const resolved = toolName && resolveOutput ? resolveOutput(toolName, b.content) : undefined;
    const effectiveCap = resolved?.cap ?? cap;
    if (b.content.length <= effectiveCap) return b;
    const policy = resolved?.policy ?? resolveRegisteredToolOutputPolicy(
      toolName ?? 'unknown',
      undefined,
      preservedToolUseIds?.has(b.tool_use_id) === true,
    );
    // When a previously-truncated block no longer fits (for example after a
    // model/context downgrade), retain its existing recovery id and re-cap the
    // inline representation. The missing raw middle cannot be re-spilled and
    // storing the old preview would create a misleading snapshot-of-snapshot.
    const existingOutputId = b.content.match(/\boutput_id=([a-f0-9]{6,64})\b/i)?.[1]
      ?? b.content.match(/get_tool_output\(\s*["']([a-f0-9]{6,64})["']/i)?.[1]
      ?? b.content.match(/get_tool_output\(\s*\{[^}]*\boutput_id\s*:\s*["']([a-f0-9]{6,64})["']/i)?.[1];
    const outputId = b.truncated || existingOutputId
      ? existingOutputId
      : toolName !== 'get_tool_output' && policy.recovery !== 'none'
        ? store?.put(b.content) ?? undefined
        : undefined;
    const originalSize = b.truncated && typeof b.originalSize === 'number'
      ? b.originalSize
      : b.content.length;
    const capped = capToolContent(
      b.content,
      effectiveCap,
      outputId,
      toolName,
      policy.capStrategy,
      policy.recovery,
      originalSize,
    );
    mutated = true;
    return {
      ...b,
      content: capped.content,
      truncated: true,
      originalSize: capped.originalSize,
    };
  });
  return mutated ? { ...m, content } : m;
}

export function normalizeMessagesForCache(
  messages: AgentMessage[],
  cap: number = PUSH_TIME_CAP,
  preserveToolOutputNames?: ReadonlySet<string>,
  resolveOutput?: (toolName: string, content?: string) => { policy: ResolvedToolOutputPolicy; cap: number },
  store?: { put(content: string): string | null },
): AgentMessage[] {
  if ((!preserveToolOutputNames || preserveToolOutputNames.size === 0) && !resolveOutput) {
    return messages.map((m) => normalizeMessageForCache(m, cap));
  }
  const preservedToolUseIds = new Set<string>();
  const toolNamesByUseId = new Map<string, string>();
  for (const m of messages) {
    if (m.role !== 'assistant') continue;
    for (const b of m.content) {
      if (b.type === 'tool_use') {
        toolNamesByUseId.set(b.id, b.name);
        if (preserveToolOutputNames?.has(b.name)) preservedToolUseIds.add(b.id);
      }
    }
  }
  return messages.map((m) => normalizeMessageForCacheWithPreservedIds(
    m,
    cap,
    preservedToolUseIds,
    toolNamesByUseId,
    resolveOutput,
    store,
  ));
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

  /**
   * Replace the prompt used by the next provider request without rebuilding
   * the runner or its tool registry. `turn_start` listeners run synchronously
   * before request assembly, making this safe for one-shot live context such
   * as a structural index that became ready while the run was active.
   */
  setSystemPromptForNextTurn(systemPrompt: string): void {
    // Mutate the existing options object: the behavior-tree RunContext keeps
    // this exact reference for the lifetime of run(), including internal turns.
    this.opts.systemPrompt = systemPrompt;
  }

  /** Effective sticky reasoning effort inherited by delegated subagents. */
  getReasoningEffort(): string | undefined {
    return this.opts.reasoningEffort;
  }
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
   *     `submit_plan`, `task_list`, `subordinate.ask_master`, etc.
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
  private pendingUserMessages: Array<{
    content: ContentBlock[];
    selectedSkillIds?: string[];
    roundMessageId?: number;
  }> = [];
  /** Persisted user-message id owning edits in the current conversational round. */
  public roundMessageId: number | null = null;
  /** Coalesced lifecycle milestone awaiting a safe compaction boundary. */
  private pendingMilestoneCompaction: string | null = null;
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
   * Set to true once the user approves a task_list({gate:'approve'}) list. Counts as a
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
   * visible in `this.messages` (or has been elided by a compaction marker —
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
   * P1b — union of line ranges actually SERVED per path (top-level reads
   * only). Powers the coverage pointer in `enforcePreReadForBridge`:
   * overlapping-but-not-identical ranges evade the exact-slice dedup key,
   * so a request fully covered by prior reads gets a pointer instead of
   * re-fetched content. Cleared per path on mutation.
   */
  private readCoverage = new ReadCoverageLedger();

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

  get currentTodos(): TodoItem[] {
    const ctx = this.opts.toolContext;
    return deriveTodosFromState(ctx.getTasksState ? ctx.getTasksState() : null);
  }

  public originalCwd: string | null = null;
  public worktreePath: string | null = null;

  private pollingResultRun: Map<string, { hash: string; count: number; firstTurn: number }> = new Map();

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
   * Phase tracking (Camada 2 — Phase Profiles) was REMOVED in favor of
   * single-model legacy behavior. The mid-turn provider swaps were too
   * disruptive to cache stability and made model behavior unpredictable.
   * Field preserved as `null` so existing telemetry stamping in index.ts
   * keeps compiling without conditional churn.
   */
  public currentPhase: string | null = null;

  /**
   * UUID of the most recent immutable metrics/turns record. Exposed so the
   * conversation commit can stamp its tool-call metadata with the same
   * filesystem record id.
   */
  public lastTurnTelemetryId: string | null = null;

  /**
   * Pending UUID of the current turn's diagnostic metric. It is outside the
   * transcript durability barrier and never rejects.
   */
  public lastTurnTelemetryIdPromise: Promise<string | null> | null = null;

  /**
   * Currently active tool tiers. When null, no tier filtering is applied
   * (all registered tools visible to the provider — legacy behaviour used
   * by subagents and tests). When a Set, the runner filters registry.list()
   * each turn so only tools whose tier is in the set reach the LLM.
   * Constant for the run: the stable catalog never promotes a tier mid-run.
   */
  public activeTiers: Set<ToolTier> | null = null;

  /** Exact catalog sent on the latest provider turn (after cap + relevance). */
  public visibleToolNames: ReadonlySet<string> | null = null;
  public authorizedToolNames: ReadonlySet<string> | null = null;
  public projectionReceipt: import('./tool-projection.js').ToolProjectionReceipt | null = null;
  public readonly stableToolCatalog = true;

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
   *  spawned subagents (read coverage, recovery, and framing). */
  public get agentLoopV2(): boolean { return this.opts.agentLoopV2 === true; }
  /** Share the root run's ordered observation bus with in-process subagents. */
  public getHookBus(): RunnerOptions['hookBus'] {
    return this.opts.hookBus;
  }
  /** Compose the inherited policy authority with child-local execution facts. */
  public createChildPolicyShadow(
    sessionContext: import('@mcp/code-agent/core/policy-shadow-adapter.js').PolicyShadowSessionContext,
  ): import('@mcp/code-agent/core/policy-shadow-adapter.js').PolicyShadowPort | undefined {
    return this.opts.policyShadowScopeFactory?.(sessionContext);
  }
  public getPolicyShadowScopeFactory(): RunnerOptions['policyShadowScopeFactory'] {
    return this.opts.policyShadowScopeFactory;
  }

  /** Read-only memory capabilities inherit scope/toggles, with child-local throttling. */
  public getMemoryContext(): Pick<RunnerOptions,
    'getRelevantProjectMemory' | 'onMemoryInjected' | 'getProjectMemoryIndex' | 'getUserMemoryIndex'> {
    const { getRelevantProjectMemory, onMemoryInjected, getProjectMemoryIndex, getUserMemoryIndex } = this.opts;
    return { getRelevantProjectMemory, onMemoryInjected, getProjectMemoryIndex, getUserMemoryIndex };
  }

  /** Public mirrors of opts.sessionId / opts.isSubagent so subagent factories can inherit them. */
  public readonly sessionId: import('@mcp/session-storage').SessionId | undefined;
  public readonly isSubagent: boolean;
  /** Optional SessionStore for input-log mirroring; see RunnerOptions. */
  public readonly sessionStore:
    | import('@mcp/session-storage/fs-store/index.js').FsSessionStore
    | undefined;
  /**
   * Resolved per-block tool-result cap for this run. Computed once in the
   * constructor from `opts.toolOutputCapLevel`, `opts.pushTimeCap`, and
   * `opts.isSubagent`. All callsites that previously read
   * `this.effectivePushTimeCap` should use this instead so the
   * unrestricted ceiling stays consistent across `buildToolResultBlock`
   * arguments and the side-file `toolOutputStore` gate.
   */
  public effectivePushTimeCap: number;
  /** Tool names whose authoritative outputs use the expanded inline budget. */
  private readonly authoritativeToolOutputNames: ReadonlySet<string>;

  /**
   * Resolved tunables for this run. Defaults to `envTunables()` when
   * `opts.tunables` is absent — i.e. legacy env-driven behavior. Hosts that
   * want per-session/per-tier control pass a snapshot built from the Decider.
   */
  public readonly tunables: CoderTunables;

  constructor(opts: RunnerOptions) {
    super();
    // `context_window` predates the runner-wide compaction plumbing. Keep one
    // resolved value internally so direct/subagent callers that still pass the
    // legacy spelling receive the same thresholds as runCoder.
    if (opts.contextWindow == null && opts.context_window != null) {
      opts.contextWindow = opts.context_window;
    }
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
    this.authoritativeToolOutputNames = new Set([
      ...(opts.preserveToolOutputNames ?? []),
      ...opts.registry.list()
        .filter((tool) => resolveRegisteredToolOutputPolicy(tool.name, tool).mode === 'authoritative')
        .map((tool) => tool.name),
    ]);
    this.messages = normalizeMessagesForCache(
      opts.initialMessages ?? [],
      this.effectivePushTimeCap,
      this.authoritativeToolOutputNames,
      (toolName, content) => this.resolveToolOutputCap(toolName, batchBudgetUnits(toolName, content)),
      this.opts.toolContext.toolOutputStore,
    );
    // back-reference so native interaction tools can pause the loop
    this.opts.toolContext.runner = this;
    this.opts.toolContext.toolOutputInlineCap = this.resolveToolOutputCap('get_tool_output').cap;
    this.opts.toolContext.toolCallLedger ??= new ToolCallLedger();
    // What this runner read/wrote whole — the overwrite rule's source of truth.
    // Subagent contexts are built field by field, so a child never shares it.
    this.opts.toolContext.fileKnowledge ??= new SessionFileKnowledge();
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
    // Freeze required pins as a reusable Set (callers may pass a one-shot iterable).
    opts.requiredPinnedTools = new Set(opts.requiredPinnedTools ?? []);
    // Seed from prior session state so the very first turn after resume can
    // already replay the previous response.
    this.previousResponseId = opts.previousResponseId ?? null;
    this.previousResponseMessageCount = opts.previousResponseMessageCount ?? null;
  }

  /** Install the DB-backed compaction sink after the host writer is ready. */
  setCompactionCheckpointHandler(
    handler: RunnerOptions['onCompactionCheckpoint'],
  ): void {
    this.opts.onCompactionCheckpoint = handler;
  }

  /** Dynamic/plugin tier map inherited by isolated sub-runners. */
  getExternalToolTiers(): RunnerOptions['externalToolTiers'] {
    return this.opts.externalToolTiers;
  }

  /** Queue a semantic milestone; repeated signals coalesce until consumed. */
  requestMilestoneCompaction(trigger: string): void {
    if (!this.pendingMilestoneCompaction) this.pendingMilestoneCompaction = trigger;
  }

  /**
   * Replace the session's lightweight todo list and emit `todos_updated`
   * so listeners (dashboard SSE, persistence) can react. Called by
   * `task_list` (track); can also be called by host code on session resume to
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
    const tasksState = ctx.getTasksState ? ctx.getTasksState() : null;
    const base = buildActiveContextBlock({
      todos: this.currentTodos,
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
   * Appends one `skill.usage` bundle event per applied skill with
   * `invoked_by='user'` so telemetry can attribute manual picks.
   * Best-effort: a logging failure does not block the request.
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
      if (this.sessionId != null && this.sessionStore) {
        void this.sessionStore
          .appendSessionEvent(this.sessionId, 'skill.usage', {
            skill_id: id,
            invoked_by: 'user',
            input_text: userInput,
          })
          .catch(() => {
            /* telemetry is best-effort; do not block the turn */
          });
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
  enterWorktreeScope(absWorktreePath: string, originalRoot?: string): void {
    if (this.worktreePath) return; // already inside — no-op, tool enforces this
    this.originalCwd = originalRoot ?? this.opts.toolContext.cwd;
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
   * Active agent identity, including live mode transitions after plan review.
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
    if (this.opts.systemPromptForAgent) this.setSystemPromptForNextTurn(this.opts.systemPromptForAgent(def));
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
      void this.opts.sessionStore
        .appendMessage({
          session_id: this.opts.sessionId,
          message: msg,
        })
        .catch((e: unknown) => {
          console.warn(
            `[coder] appendSystemReminder mirror failed: ${e instanceof Error ? e.message : String(e)}`,
          );
        });
    }
  }

  /** Replace the active provider mid-session. Takes effect on the next turn. */
  swapProvider(newProvider: ChatProvider): void {
    this.opts.provider = newProvider;
    this.opts.toolContext.toolOutputInlineCap = this.resolveToolOutputCap('get_tool_output').cap;
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
  interruptWait(info?: { kind?: 'plan' | 'question' | 'tasks' | 'subordinate_event'; agentRunId?: string | null; role?: string }): boolean {
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
   * Append a text user message. Messages are buffered and flushed at the start
   * of the next turn so they never land mid-turn between an assistant tool_use
   * block and its tool_result — which would produce an invalid message
   * sequence for the LLM API.
   */
  pushUserMessage(
    text: string,
    extras?: { selectedSkillIds?: string[]; roundMessageId?: number },
  ): void {
    this.pushPendingUserContent([{ type: 'text', text }], extras);
  }

  /**
   * Put one discovered capability into the bounded dynamic working set.
   * `find_tools` uses this before returning so the provider receives the
   * discovered schema on the very next turn; direct hidden calls retain the
   * dispatch fallback for providers that can emit an undeclared tool name.
   */
  /** Discovery reports static exclusions; argument-dependent authority remains at dispatch. */
  discoveryState(name: string): { authorization: 'blocked' | 'requires_dispatch_validation'; visible: boolean; reason?: string } {
    const blocked = (this.authorizedToolNames !== null && !this.authorizedToolNames.has(name))
      || this.opts.globalDisabledTools?.has(name) || this.opts.sessionDisabledTools?.has(name)
      || (name === 'submit_plan' && (this.opts.specMode
        || (!this.opts.planMode && !approvedPlanForRevision(this.opts.toolContext))));
    return { authorization: blocked ? 'blocked' : 'requires_dispatch_validation',
      visible: this.visibleToolNames?.has(name) ?? false,
      ...(blocked ? { reason: 'disabled_or_mode_excluded' } : {}) };
  }

  /** Queue a user message containing text plus image/document blocks. */
  pushPendingUserContent(
    content: ContentBlock[],
    extras?: { selectedSkillIds?: string[]; roundMessageId?: number },
  ): void {
    this.pendingUserMessages.push({
      content,
      selectedSkillIds: extras?.selectedSkillIds,
      roundMessageId: extras?.roundMessageId,
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
  pushUserContent(
    blocks: ContentBlock[],
    extras?: { selectedSkillIds?: string[]; roundMessageId?: number },
  ): void {
    const msg: AgentMessage = { role: 'user', content: blocks };
    if (extras?.selectedSkillIds && extras.selectedSkillIds.length > 0) {
      msg.selectedSkillIds = extras.selectedSkillIds;
    }
    if (extras?.roundMessageId != null) {
      this.roundMessageId = extras.roundMessageId;
    }
    this.messages.push(msg);
  }

  /**
   * Refresh the live filesystem-authority array after the host grants an exact
   * path-backed attachment. Tool contexts retain this array by reference.
   */
  refreshExternalFilesystemRoots(roots: ReadonlyArray<{
    id: string;
    seq?: number;
    rootPath: string;
    access: 'read' | 'write';
  }>): void {
    const current = this.opts.toolContext.externalRoots;
    if (!current || !Array.isArray(current) || Object.isFrozen(current)) return;
    const mutable = current as Array<{
      id: string;
      seq?: number;
      rootPath: string;
      access: 'read' | 'write';
    }>;
    mutable.splice(0, mutable.length, ...roots.map((root) => ({ ...root })));
  }

  setRoundMessageId(roundMessageId: number | null): void {
    this.roundMessageId = roundMessageId;
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
    this.opts.toolContext.permissionGate?.refreshPending?.();
  }

  /**
   * Apply a tool-output cap change to subsequent tool results without
   * rebuilding a warm runner. Previously this value was constructor-only,
   * leaving the composer selector stale until the worker was evicted.
   */
  setToolOutputCapLevel(level: ToolOutputCapLevel): void {
    this.opts = { ...this.opts, toolOutputCapLevel: level };
    const capBase = this.isSubagent
      ? this.tunables.subagentPushTimeCap
      : this.tunables.pushTimeCap;
    const capCeiling = this.isSubagent
      ? this.tunables.unrestrictedSubagentPushTimeCap
      : this.tunables.unrestrictedPushTimeCap;
    this.effectivePushTimeCap =
      level === 'economic'
        ? (this.opts.pushTimeCap ?? capBase)
        : capFor(level, capBase, capCeiling);
    this.opts.toolContext.toolOutputInlineCap =
      this.resolveToolOutputCap('get_tool_output').cap;
  }

  /**
   * Update the active behavior-tree context and future turns from the
   * session-owned run-limit controls. Null keeps the session unlimited.
   */
  setRunLimits(
    maxTurns: number | null,
    maxAutoContinues: number,
  ): void {
    this.opts.maxTurns = maxTurns ?? undefined;
    this.opts.maxAutoContinues = maxAutoContinues;
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

    await this.opts.toolContext.setSessionAgent(g.recommendedAgent);
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
   * owned by this class: skills, active-context, temperature resolution,
   * Responses-API state and plan/spec gates.
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
    // tier Set is shared BY REFERENCE with the BT context.
    const initialTiers = this.activeTiers ?? null;
    return runBehaviorTree({
      opts: this.opts,
      runId: this.runId,
      emit: ((event: string, ...args: unknown[]) => {
        // Mirror the loop-local turn (RunContext.turn) into the public field
        // (see the `turn` docstring). Every `turn_start` flows through here
        // for both the main runner and subagents, so this is the single point
        // that keeps the mirror live.
        if (event === 'turn_start' && typeof args[0] === 'number') this.turn = args[0];
        (this as unknown as { emit: (e: string, ...a: unknown[]) => boolean }).emit(event, ...args);
      }) as never,
      initialTiers,
      // Share the live messages array so `pushUserContent` / system reminders
      // / BT pushes all see the same backing store.
      initialMessages: this.messages,
      bridge: {
        isAbortRequested: () => this.aborted,
        buildActiveSkillsBlock: (history) => this.buildActiveSkillsBlockForLastUser(history),
        buildActiveContextBlock: () =>
          this.opts.agentLoopV2 ? this.buildActiveContextBlockForTurn() : null,
        getRelevantProjectMemory: this.opts.getRelevantProjectMemory,
        onMemoryInjected: this.opts.onMemoryInjected,
        synthesizeMemoryQuery: this.opts.synthesizeMemoryQuery,
        getSessionStateData: this.opts.getSessionStateData,
        getProjectMemoryIndex: this.opts.getProjectMemoryIndex,
        getUserMemoryIndex: this.opts.getUserMemoryIndex,
        getConversationChapterIndex: this.opts.getConversationChapterIndex,
        getRelevantConversationChapters: this.opts.getRelevantConversationChapters,
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
        toolGate: (toolName, input) => {
          const tool = this.findTool(toolName);
          if (!tool) return null;
          const args = typeof input === 'object' && input !== null && !Array.isArray(input)
            ? input as Record<string, unknown> : {};
          const policyContext = {
            planMode: !!this.opts.planMode,
            planApproved: this.planApproved,
            specMode: !!this.opts.specMode,
            specApproved: this.specApproved,
            taskScope: this.currentTaskScope,
            sandboxBound: !!this.opts.toolContext.ports?.fs || !!this.opts.toolContext.ports?.shell,
            readOnly: isReadOnlyAgent(this.opts.agentId),
          };
          const decision = evaluateToolInvocation(tool, args, policyContext);
          let refusal = decision.allowed ? null : { reason: decision.reason, detail: decision.detail };
          const scope = this.currentTaskScope;
          // A task grants a path-scoped plan unlock; it cannot bypass spec or sandbox gates.
          if (scope && decision.metadata.mutates && decision.metadata.scopeAware
            && (decision.allowed || decision.reason === 'plan_mode')) {
            const paths = extractPathsFromToolArgs(toolName, args);
            const outside = findScopeViolations(paths, scope.files, isPathInsideScope);
            if (outside.length > 0) {
              refusal = { reason: 'task_scope', detail: `Tool '${toolName}' targets paths outside task '${scope.id}': ${outside.join(', ')}` };
            } else if (paths.length > 0) {
              const scopedDecision = evaluateToolInvocation(tool, args, { ...policyContext, planApproved: true });
              refusal = scopedDecision.allowed ? null : { reason: scopedDecision.reason, detail: scopedDecision.detail };
            }
          }
          if (refusal) {
            this.emit('blocked', { runId: this.runId, turn: this.turn, tool: toolName, ...refusal });
            return `[${refusal.reason.replaceAll('_', '-')}: ${refusal.detail}]`;
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
          // family as enforcePreRead but specific to the task-list approval →
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
        reduceToolResult: (toolName, content, meta) => {
          const { policy, cap } = this.resolveToolOutputCap(toolName, batchBudgetUnits(toolName, content));
          if (policy.reducer === 'none') {
            return {
              content,
              report: {
                kind: 'none' as const,
                technique: `policy:${policy.mode}`,
                rawChars: content.length,
                shapedChars: content.length,
                cap,
                preserved: ['full'],
              },
            };
          }
          return applySmartReducerDetailed(toolName, content, cap, {
            query: this.getLastUserText(),
            args: meta?.input,
            isError: meta?.isError,
            contentFormat: meta?.contentFormat,
          });
        },
        finalizeToolResult: (a) => this.finalizeToolResultForBridge(a),
        detectPollingStuck: (toolName, content, isError, isRepeatable, turn) =>
          this.detectPollingStuckForBridge(toolName, content, isError, isRepeatable, turn),
        // `turn_start` lets the host enqueue the prior assistant/tool/goal
        // transaction synchronously; await it before this turn can reach the
        // provider. A rejection is intentionally not contained here.
        awaitTurnPersistence: this.opts.awaitTurnPersistence,
        // Drain queued user messages at the top of every Executing turn.
        // Without this, messages pushed by `runner.pushUserMessage`
        // (master forwards, SSE push from the dashboard) accumulate in
        // `pendingUserMessages` forever — the legacy loop drained at the
        // same boundary; the BT now delegates back here so the queue's
        // ownership stays on the runner class.
        flushPendingMessages: () => this.flushPendingMessages(),
        // Terminal liveness gate — a CleanFinish must not close the run while
        // /inject (or another producer) still has a message buffered for the
        // next Executing boundary.
        hasPendingMessages: () => this.hasPendingUserMessages(),
        // Per-turn telemetry persistence. The pure insert lives in
        // `core/runner/telemetry/persist-turn.ts`. The wrapper mirrors
        // the inserted id into `this.lastTurnTelemetryId` so the host's
        // `flushPendingTurn` in `index.ts` (which reads
        // `runner.lastTurnTelemetryId`) keeps working unchanged.
        persistTurnTelemetry: (input) => this.persistTurnTelemetryWrapper(input),
        peekMilestoneCompaction: () => this.pendingMilestoneCompaction,
        clearMilestoneCompaction: () => { this.pendingMilestoneCompaction = null; },
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
    const roundMessageIds: number[] = [];
    while (this.pendingUserMessages.length > 0) {
      const pending = this.pendingUserMessages.shift()!;
      const msg: AgentMessage = { role: 'user', content: pending.content };
      if (pending.selectedSkillIds && pending.selectedSkillIds.length > 0) {
        msg.selectedSkillIds = pending.selectedSkillIds;
      }
      if (pending.roundMessageId != null) {
        this.roundMessageId = pending.roundMessageId;
        roundMessageIds.push(pending.roundMessageId);
      }
      this.messages.push(msg);
    }
    if (roundMessageIds.length > 0) {
      this.emit('user_message_boundary', { roundMessageIds });
    }
  }

  /**
   * Class-bound wrapper around `persistTurnTelemetryPure`: stores the
   * inserted id on `this.lastTurnTelemetryId` so `index.ts`'s
   * `flushPendingTurn` can stamp the tool_call rows. Telemetry never breaks
   * a real turn; the pure helper already wraps its DB write in `try`.
   */
  private persistTurnTelemetryWrapper(input: {
    turn: number;
    autoContinues: number;
    usage: ChatUsage | null;
    toolUseBlocks: ReadonlyArray<ToolUseBlock>;
    toolResultBlocks: ReadonlyArray<ContentBlock>;
    historyChars: number;
    systemPromptChars: number;
    toolsDefChars: number;
    eligibleToolsDefChars?: number;
    visibleToolsCount?: number;
    toolsFingerprint?: string | null;
    capabilitySetDigest?: string | null;
    projectionDigest?: string | null;
    prefixHeadHash?: string | null;
    reducerStats?: { retired: number; freedChars: number; pendingRetired: number; pendingChars: number } | null;
    responseMeta: ChatProviderResponseMeta | null;
    compactionTriggered: boolean;
    summarizerRan: boolean;
  }): string | null | Promise<string | null> {
    const persisted = persistTurnTelemetryPure({
      store: this.opts.turnTelemetryStore,
      sessionId: this.sessionId ?? null,
      runId: this.runId,
      isSubagent: this.isSubagent,
      parentRunId: this.opts.parentRunId ?? null,
      subagentProfile: this.opts.subagentProfile ?? null,
      provider: this.opts.provider.name ?? null,
      model: this.opts.provider.model ?? null,
      turn: input.turn,
      autoContinues: input.autoContinues,
      usage: input.usage,
      toolUseBlocks: input.toolUseBlocks,
      toolResultBlocks: input.toolResultBlocks,
      historyChars: input.historyChars,
      compactionTriggered: input.compactionTriggered,
      summarizerRan: input.summarizerRan,
      systemPromptChars: input.systemPromptChars,
      toolsDefChars: input.toolsDefChars,
      eligibleToolsDefChars: input.eligibleToolsDefChars,
      visibleToolsCount: input.visibleToolsCount,
      toolsFingerprint: input.toolsFingerprint,
      capabilitySetDigest: input.capabilitySetDigest,
      projectionDigest: input.projectionDigest,
      prefixHeadHash: input.prefixHeadHash,
      reducerStats: input.reducerStats,
      responseMeta: input.responseMeta,
      agentDecisionTelemetry: this.opts.agentDecisionTelemetry,
      actualAgent: this.opts.agentId ?? null,
    });
    // Diagnostic writes never participate in transcript durability. A late
    // completion must not stamp a newer turn with an older metric identity.
    if (persisted && typeof persisted === 'object') {
      this.lastTurnTelemetryId = null;
      const pending = persisted.catch(() => null).then((resolved) => {
        if (this.lastTurnTelemetryIdPromise === pending) this.lastTurnTelemetryId = resolved;
        return resolved;
      });
      this.lastTurnTelemetryIdPromise = pending;
    } else {
      this.lastTurnTelemetryId = persisted;
      this.lastTurnTelemetryIdPromise = null;
    }

    return persisted;
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
    if (requestsFreshRead(toolName, inp)) {
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

      // Ranged reads carry the span the model is asking to quote — a prior
      // whose live content no longer shows those lines (reducer/finalize-cap
      // truncation) must count as elided, or the refusal below lies.
      const requestedSpan =
        typeof inp?.start_line === 'number' &&
        typeof inp?.end_line === 'number' &&
        inp.end_line >= inp.start_line
          ? { start: inp.start_line, end: inp.end_line }
          : undefined;
      if (allPriorReadsElided(prior.slice(0, -1), this.messages, requestedSpan)) {
        this.setTransition('pre-read-allowed-elided');
        return null;
      }

      // Historical reads are observation signals only. A real fresh read is
      // always allowed; local batch coalescing remains handled downstream.
      this.setTransition('pre-read-shadow-allowed');
      return null;
    }

    // P1b — coverage pointer for overlapping-but-not-identical ranges. The
    // exact-slice guard above never sees these (different args → different
    // readKey); telemetry showed 46% of repeated reads request a range fully
    // covered by earlier reads. Ranged requests only (symbol/no-range reads
    // carry no line math), read tools only (skeletons aren't line content),
    // and every claim is validated: current mtime must match every covering
    // segment's, and every covering tool_result must still be visible in
    // context (honesty rule — never point at compacted-away content).
    if (
      readCoverageEnabled() &&
      (toolName === 'read_file' || toolName === 'mcp__read_file') &&
      typeof inp?.start_line === 'number' &&
      typeof inp?.end_line === 'number' &&
      inp.end_line >= inp.start_line
    ) {
      let nowMtimeMs: number | undefined;
      try {
        nowMtimeMs = fsStatSync(pathResolve(this.opts.toolContext.cwd, path)).mtimeMs;
      } catch {
        /* stat failed → cannot validate staleness → allow the read */
      }
      if (nowMtimeMs !== undefined) {
        // Two-step: cheap ledger query first, then live verification. The
        // ledger records the HEADER range of each serve, but the smart
        // reducer / finalize cap can trim the delivered content after
        // recording — a truncated `[lines 550-1000]` read cut at ~761 made
        // this pointer claim lines the model never saw. Only lines still
        // visible in the live history (ledger∩live per segment) may be
        // pointed at.
        const claimed = this.readCoverage.coveringSegments(
          path,
          inp.start_line,
          inp.end_line,
          { requireMtimeMs: nowMtimeMs },
        );
        if (claimed !== null) {
          const covering = this.readCoverage.coveringSegments(
            path,
            inp.start_line,
            inp.end_line,
            {
              requireMtimeMs: nowMtimeMs,
              liveSpanOf: (s) => {
                const r = findToolResultByUseId(s.useId, this.messages);
                return r && !r.isElided ? visibleSpanOf(r.content) : null;
              },
            },
          );
          if (covering !== null) {
            this.setTransition('pre-read-coverage-pointer');
            // Pointer, not content — keep the exact-slice ledger honest.
            prior.pop();
            return {
              content: buildCoveragePointer({
                toolName,
                path,
                start: inp.start_line,
                end: inp.end_line,
                segments: covering,
              }),
              isError: false,
            };
          }
          // Ledger claimed coverage but the live content cannot prove it —
          // allow the read; the transition records the degradation so
          // telemetry can measure how often trims invalidate coverage.
          this.setTransition('pre-read-coverage-degraded');
        }
      }
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
    reductionReport?: ReductionReport;
    sourceTruncations?: import('@mcp/code-agent/core/tool.js').ToolSourceTruncation[];
  }): { content: string; truncated?: boolean; originalSize?: number; outputId?: string; inlineCap: number; reductionReport: ReductionReport } {
    const { policy, cap } = this.resolveToolOutputCap(
      args.toolName,
      batchBudgetUnits(args.toolName, args.shapedContent),
    );
    return finalizeToolOutput({
      toolName: args.toolName,
      rawContent: args.rawContent,
      shapedContent: args.shapedContent,
      isError: args.isError,
      cap,
      store: this.opts.toolContext.toolOutputStore,
      reductionReport: args.reductionReport,
      sourceTruncations: args.sourceTruncations,
      policy,
    });
  }

  /**
   * `budgetUnits` > 1 marks a block that carries several tool results (a
   * batched code_exec return): it gets that many single-result budgets, the
   * same total the calls would receive as separate top-level results, still
   * bounded by `maxInlineChars` and the context-relative ceiling.
   */
  private resolveToolOutputCap(toolName: string, budgetUnits = 1): {
    policy: ResolvedToolOutputPolicy;
    cap: number;
  } {
    const tool = this.opts.registry.get(toolName);
    // Backward compatibility: hosts have long used preserveToolOutputNames
    // for dynamic/extension tools that cannot declare an outputPolicy. Treat
    // those names as authoritative in the live path too (not only on resume),
    // so they still bypass lossy reducers and receive the expanded budget.
    const policy: ResolvedToolOutputPolicy = resolveRegisteredToolOutputPolicy(
      toolName,
      tool,
      this.authoritativeToolOutputNames.has(toolName),
    );
    let targetCap = policy.mode === 'authoritative'
      ? Math.max(this.effectivePushTimeCap, this.opts.preservedToolOutputCap ?? PRESERVED_TOOL_OUTPUT_CAP)
      : this.effectivePushTimeCap * Math.max(1, Math.floor(budgetUnits));
    if (policy.maxInlineChars !== undefined) {
      // `maxInlineChars` is a ceiling, including for authoritative tools. The
      // latter start from an expanded default budget, but an explicit smaller
      // per-tool maximum must still win at elevated session cap levels.
      targetCap = Math.min(targetCap, policy.maxInlineChars);
    }
    return {
      policy,
      // Keep the context-relative ceiling as the non-negotiable safety net.
      cap: resolveFinalizeCap(targetCap, this.opts.provider.model, this.opts.contextWindow),
    };
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
        let servedMtimeMs: number | undefined;
        try {
          servedMtimeMs = fsStatSync(pathResolve(this.opts.toolContext.cwd, path)).mtimeMs;
        } catch {
          /* file may not exist */
        }
        if (list && list.length > 0) {
          const tail = list[list.length - 1];
          if (tail.useId === args.toolUseId) {
            tail.contentHash = createHash('sha1').update(args.rawContent).digest('hex');
            tail.mtimeMs = servedMtimeMs;
          }
        }
        // P1b — record the range actually SERVED (parsed from the result
        // header, not the requested args: auto-full/clamping can serve more
        // or less than asked). Diff/pointer results parse to null — only
        // real line content accrues coverage. The header states intent and
        // survives trims, so clamp it to the numbered lines still present in
        // the SHAPED content (the smart reducer runs before this hook). The
        // finalize cap runs after — the query-time liveSpanOf check covers
        // that layer and any later in-place rewrite.
        const served = parseServedRange(args.rawContent);
        if (served) {
          const visible = visibleSpanOf(args.content);
          const start = visible ? Math.max(served.start, visible.start) : served.start;
          const end = visible ? Math.min(served.end, visible.end) : served.end;
          if (end >= start) {
            this.readCoverage.noteServed(path, {
              start,
              end,
              turn: args.turn,
              useId: args.toolUseId,
              mtimeMs: servedMtimeMs,
            });
          }
        }
      }

      const pending = this.pendingDiffRereads.get(args.toolUseId);
      if (pending) {
        this.pendingDiffRereads.delete(args.toolUseId);
        const priorResult = findToolResultByUseId(pending.priorUseId, this.messages);
        if (priorResult && !priorResult.isElided) {
          const diff = buildSimpleLineDiff(priorResult.content, args.rawContent, 3);
          nextContent = `${rereadAfterEditHeader(args.name, pending.path, pending.priorTurn)}\n\n${diff}`;
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
          const p = m[1].trim();
          this.recentWrites.set(p, args.turn);
          this.readCoverage.noteMutation(p);
        }
      } else {
        const path = getStringField(args.input, 'path', 'file_path');
        if (path) {
          this.recentWrites.set(path, args.turn);
          this.readCoverage.noteMutation(path);
        }
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
      console.warn(
        `[coder] polling observation: ${toolName} same result ${next.count}× at turn ${turn}`,
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
      if (text.trim()) return text.slice(0, 4000);
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
    const hookBus = this.opts.hookBus;

    const startedAt = Date.now();
    const startStage = this.isSubagent ? 'agent_spawned' : 'run_started';
    const terminalStage = this.isSubagent ? 'agent_terminal' : 'run_terminal';
    // HookBus contains handler failures, but keep this boundary defensive so
    // lifecycle observation can never become execution authority.
    try {
      await hookBus?.fireObservation(startStage, {
        runId: this.runId,
        sessionId: this.sessionId ?? null,
        agentId: this.opts.agentId ?? null,
        subagent: this.isSubagent,
      });
    } catch {
      // Observation only.
    }

    let outcome: { ok: boolean; reason?: string; errorType?: string } = { ok: false };
    try {
      const result = await this.runViaBehaviorTree();
      outcome = { ok: true, reason: result.reason };
      // Company lifecycle hooks predate HookBus. Keep their completion contract
      // at the same terminal boundary, including hosts without a HookBus.
      if (!this.isSubagent && this.opts.hookRegistry?.hasHandlers) {
        try {
          await this.opts.hookRegistry.fireCompletion({
            sessionId: this.sessionId ?? asSessionId(this.runId),
            projectName: this.opts.toolContext.projectName,
            provider: this.provider.name,
            model: this.provider.model,
            turn: this.turn,
            reason: result.reason,
            totalUsage: result.totalUsage,
            turnCount: this.turn,
          });
        } catch {
          // Lifecycle observers cannot change the run outcome.
        }
      }
      return result;
    } catch (error) {
      outcome = {
        ok: false,
        errorType: error instanceof Error ? error.name : 'UnknownError',
      };
      throw error;
    } finally {
      try {
        await hookBus?.fireObservation(terminalStage, {
          runId: this.runId,
          sessionId: this.sessionId ?? null,
          agentId: this.opts.agentId ?? null,
          subagent: this.isSubagent,
          durationMs: Date.now() - startedAt,
          ...outcome,
        });
      } catch {
        // Observation only.
      }
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
  push((args as { from_path?: unknown }).from_path);
  push((args as { to_path?: unknown }).to_path);
  push(args.cwd);
  push(args.workdir);
  const paths = (args as { paths?: unknown }).paths;
  if (Array.isArray(paths)) for (const p of paths) push(p);

  // Shell scope is advisory: it cannot infer all effects of arbitrary code.
  const command = toolName === 'run_command' ? args.command : toolName === 'exec_command' ? args.cmd : undefined;
  if (typeof command === 'string') {
    const cmd = command;
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
