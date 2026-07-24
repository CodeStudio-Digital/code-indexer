/**
 * Tool dispatch with invocation-scoped guards. Walks the assistant's emitted
 * tool_use blocks serially:
 *
 *   1. Resolve repeat/execution policy and normalize the equality key.
 *   2. Run policy + permission gates (denials never enter repeat state).
 *   3. Reuse stable reads only inside this batch/epoch; volatile/pollable
 *      calls execute; hazardous mutations warn on #2 and stop on #3.
 *   4. Observe unchanged cross-turn results after execution without blocking.
 *   5. Build a single tool-role AgentMessage with all the tool_result
 *      blocks so the next turn sees them as one atomic batch.
 *
 * Serial (not parallel) by design: tools may share filesystem state and
 * parallel dispatch was the source of several "two writes raced" bugs in
 * the legacy loop. If we want parallelism later, it goes per-tool via an
 * allowlist (e.g. read-only tools only).
 */
import type { AgentMessage, ContentBlock } from '@mcp/code-agent/core/messages.js';
import type { ToolRegistry } from '@mcp/code-agent/core/registry.js';
import type {
  ToolContext,
  CoderTool,
  GuardVerdict,
  ToolSourceTruncation,
  CapabilityLifecycleHooks,
  CapabilityPolicyPort,
} from '@mcp/code-agent/core/tool.js';
import type { DetailedReduction, ReductionReport } from '@mcp/code-agent/core/smart-reducers.js';
import type { ToolCallLedgerEntry } from '@mcp/code-agent/core/tool-call-ledger.js';
import {
  checkDupCall,
  createInvocationGuardState,
  dedupPolicyMode,
  normalizeGuardInput,
} from '../guards/tuple-hash-dedup.js';
import type { NoProgressTracker } from '../guards/no-progress.js';
import {
  checkFailureStreak,
  buildFailureStreakReminderMarker,
  buildFailureStreakRefusalText,
  type FailureStreakState,
  type FailureStreakVerdict,
} from '../guards/failure-streak.js';
import type { DupCallEntry } from '../machine/types.js';
import { withAbortAndTimeout, isTimeoutError, isAbortError } from './executing-abort.js';
import { resolveToolInvocationMetadata } from '../../policy.js';
import { resolveToolTimeoutMs, NORMAL_TIMEOUT_MS } from '../../tool-timeouts.js';
import { normalizeSourceTruncations } from '../tool-output-telemetry.js';
import { asAbortSignal } from '../../abort-signal.js';

/**
 * Per-invocation timeout is delegated to `resolveToolTimeoutMs` (the
 * `core/tool-timeouts.ts` classification): interactive/explicit-Infinity tools
 * get no timeout; known-slow tools (subagents, code_exec, run_command, research,
 * MCP) get 30 min; everything else 5 min. Interactivity is resolved through
 * `resolveToolMetadata` because the built-in interactive set declares the
 * flag in `policy.ts` (BUILTIN_CLASSIFICATION), NOT on the tool object —
 * reading the raw `tool.interactive` here is exactly what made submit_plan /
 * ask_user hit the 5-min timeout while blocked on the user. Override the
 * tiers via MCP_TOOL_NORMAL_TIMEOUT_MS / MCP_TOOL_SLOW_TIMEOUT_MS.
 */

/**
 * Why a tool_result was synthesized/replaced by the harness instead of (or on
 * top of) a real invocation. Persisted to telemetry (`coder_tool_calls.
 * refusal_kind`) so guard refusals are separable from genuine tool failures —
 * `is_error=1` alone conflated them and poisoned per-tool error rates.
 */
export type RefusalKind =
  | 'gate'
  | 'pre-read'
  | 'task-mode'
  | 'dedup'
  | 'user_denied' // permission-gate denial — name matches classifyToolRefusal's legacy tag
  | 'failure-streak'
  | 'polling-stuck'
  | 'timeout'
  | 'abort';

export interface DispatchedToolResult {
  toolUseId: string;
  name: string;
  content: string;
  isError: boolean;
  durationMs: number;
  /** True when synthesized by the dedup refusal path (no real invocation). */
  wasRefusedByDedup: boolean;
  /** Set on every harness-synthesized refusal/replacement — see RefusalKind. */
  refusalKind?: RefusalKind;
  /**
   * Extra content blocks (e.g. an image from `view_image`/`preview_screenshot`)
   * the tool wants the model to SEE. Surfaced as a synthetic user message
   * right after the tool message — provider-agnostic vision.
   */
  extraUserBlocks?: ContentBlock[];
  /** Raw tool output size (chars) BEFORE any reduce/cap — for savings telemetry. */
  rawChars?: number;
  /** Declared model-facing representation and hidden structured payload size. */
  contentFormat?: 'text' | 'markdown' | 'json';
  structuredOutputChars?: number | null;
  /** Set by the live finalize hook when the fail-safe cap truncated content. */
  truncated?: boolean;
  originalSize?: number;
  reductionReport?: ReductionReport;
  outputId?: string;
  /** Explicit producer-side omission metadata; never inferred from content. */
  sourceTruncations?: ToolSourceTruncation[];
  ledgerEntry?: ToolCallLedgerEntry;
  /** Structured guard/reuse/shadow metadata carried into persistence. */
  guardVerdict?: GuardVerdict;
  /** Workspace/state version at result delivery, independent of guard action. */
  stateEpoch?: number;
}

export interface DispatchArgs {
  toolUses: Array<{ id: string; name: string; input: Record<string, unknown> }>;
  registry: ToolRegistry;
  toolContext: ToolContext;
  turn: number;
  dupCalls: Map<string, DupCallEntry>;
  /** Run-scoped, post-result observation and state epoch. */
  noProgressTracker?: NoProgressTracker;
  /**
   * Optional pre-dispatch gate. Returning a non-null string blocks the
   * invocation and synthesises an error tool_result carrying that text
   * (plan/spec mode + mutating tool, sandbox required, etc.). Runs
   * BEFORE the tuple-hash check so a blocked call doesn't pollute the
   * dedup counter.
   */
  toolGate?: (
    toolName: string,
    input: unknown,
  ) => string | null | Promise<string | null>;
  /**
   * Pre-read enforcement — refuse re-reads of the same path+slice that
   * a prior turn already produced. Runs AFTER `toolGate` and BEFORE the
   * tuple-hash check (so a refused re-read doesn't bump dedup).
   */
  enforcePreRead?: (
    toolName: string,
    input: unknown,
    turn: number,
    toolUseId: string,
  ) => string | { content: string; isError?: boolean } | null;
  /**
   * Task-mode gate — enforces `execution_mode='all-subagent'` by refusing
   * mutating tools that would bypass `execute_task`. Pure consult; no
   * dedup counter side-effect.
   */
  enforceTaskMode?: (toolName: string, toolMutates: boolean) => string | null;
  /**
   * Fase 2 Policy Engine shadow port (default-off). When present AND its
   * flags are enabled, it evaluates a shadow PolicyDecision, records the
   * comparison vs. the legacy gate, and — only when `CODER_POLICY_ENGINE_ENFORCE`
   * is set (dormant) — may itself refuse a call. When absent, the dispatch path
   * is byte-identical to the pre-Fase-2 behavior. It runs immediately BEFORE the
   * permission gate so its enforcement, if ever enabled, precedes the legacy
   * approval prompt.
   */
  policyShadow?: CapabilityPolicyPort;
  /** Ordered lifecycle observation around every requested capability. */
  capabilityHooks?: CapabilityLifecycleHooks;
  /** Smart-reducer applied to the raw result content before push. */
  reduceToolResult?: (
    toolName: string,
    content: string,
    meta?: {
      input: Record<string, unknown>;
      isError: boolean;
      contentFormat: 'text' | 'markdown' | 'json';
    },
  ) => string | DetailedReduction;
  /**
   * Live final shaping: spill the raw original to the side-file store + apply
   * the generic fail-safe cap with an output_id marker. Returns the content to
   * push plus the `truncated` flag (so resume's `normalizeMessageForCache`
   * won't re-cut). Skipped when absent (tests / paths without a store).
   */
  finalizeToolResult?: (args: {
    toolName: string;
    rawContent: string;
    shapedContent: string;
    isError: boolean;
    reductionReport?: ReductionReport;
    sourceTruncations?: ToolSourceTruncation[];
  }) => { content: string; truncated?: boolean; originalSize?: number; outputId?: string; inlineCap?: number; reductionReport?: ReductionReport };
  /**
   * Post-result hook for runner-owned state that needs the real tool_use id
   * and raw content (mutation-aware reread diffs, write tracking, etc.).
   */
  postProcessToolResult?: (args: {
    toolUseId: string;
    name: string;
    input: Record<string, unknown>;
    rawContent: string;
    content: string;
    isError: boolean;
    turn: number;
  }) => { content: string; isError?: boolean } | null | void;
  /**
   * Polling-stuck detector. Returns a refusal string when a polling
   * tool returned identical content N times in a row. Replaces the
   * shaped content with the refusal payload.
   */
  detectPollingStuck?: (
    toolName: string,
    content: string,
    isError: boolean,
    isRepeatable: boolean,
    turn: number,
  ) => string | null;
  /**
   * Telemetry hook — fired BEFORE each tool invocation lands. Lets the
   * dashboard show a "tool started" badge in real time. Skipped when the
   * call is refused by toolGate, pre-read, or dedup (the synthesized
   * result emits `tool_call_result` directly).
   */
  onToolCallStart?: (id: string, name: string, input: Record<string, unknown>) => void;
  /**
   * Telemetry hook — fired AFTER the final shaped content is ready
   * (post smart-reducer + polling-stuck shaping). Carries the size the
   * LLM will actually see so dashboards can show per-call savings.
   */
  onToolCallFinalized?: (id: string, shapedChars: number) => void;
  /**
   * Telemetry hook — fired periodically (default every 10s) while a tool
   * invocation is in flight. Drives the dashboard's StuckBanner reset
   * during long-running tools (web_fetch, run_command, spawn_agent
   * parallel batches). Skipped when the tool is `interactive: true` or
   * `timeoutMs: Infinity` — the runner is correctly idle there.
   */
  onToolProgress?: (
    id: string,
    name: string,
    elapsedMs: number,
    note?: string,
    kind?: 'heartbeat' | 'progress',
  ) => void;
  /** Heartbeat interval in ms. Default 10 000 (10s). */
  toolProgressIntervalMs?: number;
  /**
   * PR 5 — per-tool failure-streak state. Shared across all dispatched
   * tools in this turn (a single successful call resets the streak for
   * its tool). Passed in by `ExecutingNode` from `ctx.failureStreaks`.
   * Pass `undefined` to disable the guard (tests / subagent paths that
   * don't need the protection).
   */
  failureStreakState?: FailureStreakState;
  /**
   * PR 5 — emitted when the failure-streak guard returns a non-pass
   * verdict. The runner mirrors this onto `tool_loop_intervention` so
   * the dashboard surfaces a banner. Optional: when omitted, the
   * verdict still mutates state but no event fires.
   */
  onFailureStreakIntervention?: (payload: {
    toolName: string;
    kind: 'reminder' | 'refuse';
    count: number;
    firstFailureTurn: number;
    lastError: string;
    turn: number;
  }) => void;
  /**
   * Factory for the nested-call guard/telemetry observer. Consulted once per
   * dispatched tool; the Executing node only returns one for `code_exec`
   * parents (and when nested guards are enabled). Invocation counts live in
   * the observer's local scope; only result-aware failure/no-progress state
   * is shared with direct dispatch.
   */
  makeNestedObserver?: (
    parentToolUseId: string,
    parentToolName: string,
  ) => import('@mcp/code-agent/core/tool.js').NestedToolObserver | undefined;
  /**
   * Names visible to the model THIS turn (from buildTools). When provided,
   * a call to a registered-but-hidden name (tier-hidden or cap-cut)
   * executes anyway and is pinned via `onToolPinned`; the result carries a
   * deterministic `[toolset]` suffix telling the model the tool is now in
   * its list. Omit to disable hidden-call handling (tests / subagents).
   * Kill switch: CODER_TOOL_PIN_DISABLE=1.
   */
  visibleToolNames?: ReadonlySet<string>;
  /**
   * Already-pinned names (LIVE reference to the run's pin set). Consulted
   * so a tool pinned earlier in the same batch doesn't get a duplicate
   * suffix.
   */
  pinnedTools?: ReadonlySet<string>;
  /** Fired when a hidden registered tool executed — pin it for next turn. */
  onToolPinned?: (name: string) => void;
  /**
   * Hard block for admin/session-disabled tools. Before this existed a
   * disabled tool still EXECUTED when the model emitted its name — the
   * disabled sets only filtered the PRESENTATION in buildTools. Returns
   * the refusal text, or null when the tool is allowed.
   */
  isToolBlocked?: (name: string) => string | null;
  /**
   * Supervisor recovery hooks (Phase 2.3). When provided, each non-interactive
   * invocation registers its AbortController by tool_use_id so an external
   * watcher can abort a single stuck call; on abort, `consumeInjectedToolError`
   * yields the supervisor's message to surface as the tool_result (vs the
   * generic "cancelled by user/session" text). All optional — absent in
   * subagents / tests, where behaviour is unchanged.
   */
  registerInFlightTool?: (toolUseId: string, ctl: AbortController) => void;
  unregisterInFlightTool?: (toolUseId: string) => void;
  consumeInjectedToolError?: (toolUseId: string) => string | undefined;
}

export interface DispatchResult {
  results: DispatchedToolResult[];
  /** True when at least one call was refused — caller routes to Planning. */
  toolLoopDetected: boolean;
  /**
   * PR 5 — which guard fired the most recent refusal in this batch.
   * `undefined` when `toolLoopDetected` is false. Routed by the
   * Executing node into `events.toolLoopDetected({ guard })` so the
   * orchestrator and dashboard see WHICH guard fired (not just THAT
   * one did).
   */
  loopGuard?: 'tuple-hash' | 'doom-loop' | 'failure-streak';
  /**
   * A1 — tool + repetition count behind the most recent refusal in this
   * batch (mirrors `loopGuard`: last one wins). Threaded into
   * `events.toolLoopDetected` so Planning can NAME the loop in its
   * reflection reminder instead of a generic "a repeated tool call".
   */
  loopDetail?: { toolName: string; count: number };
}

export async function dispatchTools(args: DispatchArgs): Promise<DispatchResult> {
  const results: DispatchedToolResult[] = [];
  let toolLoopDetected = false;
  // PR 5 — which guard fired last. Tracked so the Executing node can
  // surface the correct guard kind to the orchestrator.
  let loopGuard: DispatchResult['loopGuard'] | undefined;
  // A1 — tool/count behind the last refusal (mirrors loopGuard).
  let loopDetail: DispatchResult['loopDetail'];
  const invocationGuard = createInvocationGuardState(
    args.noProgressTracker?.stateEpoch ?? 0,
  );
  // Successful, stable read results may be reused only inside this dispatch
  // batch and state epoch. Nothing survives into a later turn.
  const reusableResults = new Map<string, {
    result: DispatchedToolResult;
    count: number;
  }>();

  for (const tu of args.toolUses) {
    const tool = lookupTool(args.registry, tu.name);
    const normalizedInput = normalizeGuardInput(tool, tu.input);
    const resolvedMetadata = tool
      ? resolveToolInvocationMetadata(tool, normalizedInput)
      : null;
    const isRepeatable = resolvedMetadata
      ? resolvedMetadata.repeatPolicy === 'pollable'
      : false;
    // Interactivity comes from the policy classification, NOT the raw tool
    // object: the built-in interactive tools (submit_plan, ask_user,
    // submit_tasks, submit_spec, master variants) declare `interactive` in
    // `policy.ts`'s BUILTIN_CLASSIFICATION, not on their CoderTool.
    const interactive = resolvedMetadata?.interactive ?? false;
    const hookBase = {
      toolUseId: tu.id,
      toolName: tu.name,
      turn: args.turn,
      known: tool !== null,
    };
    let hookResult: DispatchedToolResult | undefined;
    if (args.capabilityHooks) {
      try {
        await args.capabilityHooks.before(hookBase);
      } catch {
        // Observation hooks never alter capability execution.
      }
    }
    const pushResult = async (result: DispatchedToolResult): Promise<void> => {
      results.push(result);
      hookResult = result;
    };

    try {

    // Hidden-call handling (pin mechanism). A registered tool can be absent
    // from the model's visible list (tier-hidden or cap-cut) yet still be
    // called by name — find_tools tells the model to do exactly that.
    // Policy: disabled tools hard-block; goal-gated create_goal refuses
    // with redirection; everything else flows through ALL the gates below,
    // executes, and is pinned at the result tail.
    const pinDisabled = process.env.CODER_TOOL_PIN_DISABLE === '1';
    // Disabled/policy-blocked capabilities are a security boundary, not a
    // pinning feature. The pin kill switch may suppress hidden-tool discovery,
    // but it must never make a blocked registered tool executable.
    if (tool && args.isToolBlocked) {
      const blockedText = args.isToolBlocked(tu.name);
      if (blockedText !== null) {
        await pushResult({
          toolUseId: tu.id,
          name: tu.name,
          content: blockedText,
          isError: true,
          durationMs: 0,
          wasRefusedByDedup: false,
          refusalKind: 'gate',
          stateEpoch: invocationGuard.stateEpoch,
        });
        continue;
      }
    }
    const hiddenFromModel =
      !pinDisabled &&
      !!tool &&
      !!args.visibleToolNames &&
      !args.visibleToolNames.has(tu.name) &&
      !args.pinnedTools?.has(tu.name);
    if (hiddenFromModel && tu.name === 'create_goal') {
      // create_goal is hidden by the goal-gate while a goal is in_progress
      // (sessions 656/658 looped on it) — pinning would permanently defeat
      // that gate, so refuse with the correct redirection instead.
      const goal = args.toolContext.getGoalState?.();
      if (goal && goal.status === 'in_progress') {
        await pushResult({
          toolUseId: tu.id,
          name: tu.name,
          content:
            '[goal-gate] a goal is already in_progress — call update_goal to progress or complete it instead of creating a new one.',
          isError: true,
          durationMs: 0,
          wasRefusedByDedup: false,
          refusalKind: 'gate',
          stateEpoch: invocationGuard.stateEpoch,
        });
        continue;
      }
    }

    // Pre-dispatch gate (plan/spec/policy refusal). Synthesises an error
    // tool_result without touching the dedup counter — the call never
    // happened from the agent's POV.
    const gateRefusal = await args.toolGate?.(tu.name, normalizedInput) ?? null;
    if (gateRefusal !== null) {
      await pushResult({
        toolUseId: tu.id,
        name: tu.name,
        content: gateRefusal,
        isError: true,
        durationMs: 0,
        wasRefusedByDedup: false,
        refusalKind: 'gate',
        stateEpoch: invocationGuard.stateEpoch,
      });
      continue;
    }

    // Pre-read enforcement (Row 32 from agent-research comparisons).
    // Refuses re-reads BEFORE the dedup check so the dedup counter
    // stays meaningful only for non-read tools.
    const preReadRefusal = args.enforcePreRead?.(
      tu.name,
      normalizedInput,
      args.turn,
      tu.id,
    ) ?? null;
    // Hybrid/observe never turn a historical read into a hard error. Preserve
    // the mtime/coverage-aware non-error pointer, but ignore the legacy string
    // refusal and fetch fresh content. `force_reread:true` already makes the
    // bridge return null and also bypasses the local reuse path below.
    const enforcePreReadResult =
      preReadRefusal !== null &&
      (typeof preReadRefusal !== 'string' || dedupPolicyMode() === 'legacy');
    if (enforcePreReadResult) {
      const content = typeof preReadRefusal === 'string' ? preReadRefusal : preReadRefusal.content;
      const isError = typeof preReadRefusal === 'string' ? true : preReadRefusal.isError ?? true;
      const guardVerdict: GuardVerdict = isError
        ? {
            action: 'block',
            reason: 'legacy-pre-read',
            refusalKind: 'pre-read',
            shouldReflect: false,
            affectsFailureStreak: false,
            sourceTool: tu.name,
            originToolUseId: tu.id,
            stateEpoch: invocationGuard.stateEpoch,
          }
        : {
            action: 'reuse',
            reason: 'read-coverage-pointer',
            shouldReflect: false,
            affectsFailureStreak: false,
            sourceTool: tu.name,
            originToolUseId: tu.id,
            stateEpoch: invocationGuard.stateEpoch,
          };
      await pushResult({
        toolUseId: tu.id,
        name: tu.name,
        content,
        isError,
        durationMs: 0,
        wasRefusedByDedup: false,
        // The auto-downgrade variant (isError=false) is a degraded SUCCESS,
        // not a refusal — leave it untagged so error analytics stay clean.
        ...(isError ? { refusalKind: 'pre-read' as const } : {}),
        guardVerdict,
        stateEpoch: invocationGuard.stateEpoch,
      });
      continue;
    }

    // Task-mode gate (execution_mode='all-subagent'). Refuses mutating
    // tools that would bypass the task workflow. Runs AFTER pre-read so
    // a write that would have been pre-read-refused stays on that
    // (clearer) error path, and BEFORE the tuple-hash so the dedup
    // counter isn't polluted by gate-blocked calls.
    const toolMutates = resolvedMetadata?.mutates ?? false;
    const taskModeRefusal = args.enforceTaskMode?.(tu.name, !!toolMutates) ?? null;
    if (taskModeRefusal !== null) {
      await pushResult({
        toolUseId: tu.id,
        name: tu.name,
        content: taskModeRefusal,
        isError: true,
        durationMs: 0,
        wasRefusedByDedup: false,
        refusalKind: 'task-mode',
        stateEpoch: invocationGuard.stateEpoch,
      });
      continue;
    }

    // Telemetry: signal start BEFORE invoking so the dashboard can render
    // "tool in flight" the moment the call is dispatched.
    args.onToolCallStart?.(tu.id, tu.name, normalizedInput);

    // Fase 2 Policy Engine shadow (default-off). Runs BEFORE the legacy
    // permission gate so that, if enforcement is ever enabled (dormant here),
    // its decision precedes the legacy approval prompt. When the port is
    // absent — the default — this block is skipped entirely and the path is
    // byte-identical to the pre-Fase-2 behavior. In shadow mode the port
    // records its comparison and returns `{ refuse: false }`, so nothing
    // changes; only with CODER_POLICY_ENGINE_ENFORCE can it refuse.
    if (args.policyShadow) {
      const shadow = await args.policyShadow({
        tool,
        toolUseId: tu.id,
        toolName: tu.name,
        toolInput: normalizedInput,
        turn: args.turn,
      });
      if (shadow?.refuse) {
        await pushResult({
          toolUseId: tu.id,
          name: tu.name,
          content: shadow.refusalText,
          isError: true,
          durationMs: 0,
          wasRefusedByDedup: false,
          refusalKind: 'user_denied',
          stateEpoch: invocationGuard.stateEpoch,
        });
        continue;
      }
    }

    // Permission gate (modes 'ask'/'auto') — may pause awaiting user
    // approval. Sits AFTER onToolCallStart (the dashboard block must exist
    // as the anchor for the approval card) and BEFORE the duration clock,
    // heartbeat and timeout wrappers (decision time is free; a long pause
    // must not be killed by toolTimeoutMs). It intentionally runs BEFORE the
    // invocation guard: a denied attempt never increments repeat counters.
    const permissionGate = args.toolContext.permissionGate;
    if (permissionGate) {
      const decision = await permissionGate.check({
        toolUseId: tu.id,
        toolName: tu.name,
        input: normalizedInput,
        tool: tool ?? undefined,
        parentToolUseId: args.toolContext.approvalAnchorId,
        turn: args.turn,
      });
      if (!decision.allowed) {
        await pushResult({
          toolUseId: tu.id,
          name: tu.name,
          content: decision.refusalText,
          isError: true,
          durationMs: 0,
          wasRefusedByDedup: false,
          refusalKind: 'user_denied',
          stateEpoch: invocationGuard.stateEpoch,
        });
        continue;
      }
    }

    const verdict = checkDupCall({
      name: tu.name,
      input: normalizedInput,
      normalizedInput,
      isRepeatable,
      repeatPolicy: resolvedMetadata?.repeatPolicy,
      turn: args.turn,
      useId: tu.id,
      dupCalls: args.dupCalls,
      invocationState: invocationGuard,
      stateEpoch: invocationGuard.stateEpoch,
      forceReread: normalizedInput.force_reread === true,
    });

    const noProgressRefusal = args.toolContext.toolCallLedger?.checkRepeat({
      name: tu.name,
      args: normalizedInput,
      repeatPolicy: resolvedMetadata?.repeatPolicy,
      mutates: resolvedMetadata?.mutates,
    });
    if (noProgressRefusal) {
      const guardVerdict: GuardVerdict = {
        action: 'block',
        reason: 'cross-turn-no-progress',
        refusalKind: 'dedup',
        shouldReflect: true,
        affectsFailureStreak: false,
        count: noProgressRefusal.count,
        sourceTool: tu.name,
        originToolUseId: tu.id,
        stateEpoch: invocationGuard.stateEpoch,
      };
      await pushResult({
        toolUseId: tu.id,
        name: tu.name,
        content: `[no-progress REFUSED: \`${tu.name}\` repeated without new results. Switch strategy before retrying.]`,
        isError: true,
        durationMs: 0,
        wasRefusedByDedup: true,
        refusalKind: 'dedup',
        guardVerdict,
        stateEpoch: invocationGuard.stateEpoch,
      });
      toolLoopDetected = true;
      loopGuard = 'doom-loop';
      loopDetail = { toolName: tu.name, count: noProgressRefusal.count };
      continue;
    }

    if (verdict.action === 'block') {
      await pushResult({
        toolUseId: tu.id,
        name: tu.name,
        content: verdict.refuseText,
        isError: true,
        durationMs: 0,
        wasRefusedByDedup: true,
        refusalKind: 'dedup',
        guardVerdict: verdict,
        stateEpoch: invocationGuard.stateEpoch,
      });
      toolLoopDetected = verdict.shouldReflect;
      loopGuard = 'tuple-hash';
      loopDetail = { toolName: tu.name, count: verdict.entry.count };
      continue;
    }

    const reusable =
      verdict.action === 'allow' &&
      resolvedMetadata?.repeatPolicy === 'stable' &&
      resolvedMetadata.executionClass === 'read' &&
      !interactive &&
      normalizedInput.force_reread !== true
        ? reusableResults.get(`${verdict.key}|epoch:${invocationGuard.stateEpoch}`)
        : undefined;
    if (reusable && !reusable.result.isError && !reusable.result.extraUserBlocks) {
      reusable.count += 1;
      const reuseVerdict: GuardVerdict = {
        action: 'reuse',
        reason: 'same-batch-stable-result',
        shouldReflect: false,
        affectsFailureStreak: false,
        count: reusable.count,
        sourceTool: tu.name,
        originToolUseId: reusable.result.toolUseId,
        stateEpoch: invocationGuard.stateEpoch,
      };
      const reused: DispatchedToolResult = {
        ...reusable.result,
        toolUseId: tu.id,
        name: tu.name,
        durationMs: 0,
        wasRefusedByDedup: false,
        refusalKind: undefined,
        ledgerEntry: undefined,
        guardVerdict: reuseVerdict,
      };
      args.onToolCallFinalized?.(tu.id, reused.content.length);
      await pushResult(reused);
      continue;
    }

    const reminderPrefix = verdict.kind === 'allow-with-reminder' ? verdict.reminderText : '';

    const t0 = Date.now();
    let invocationContent: string;
    let invocationIsError = false;
    let invocationContentFormat: 'text' | 'markdown' | 'json' = 'text';
    let invocationStructuredChars: number | null = null;
    let invocationStructuredData: unknown;
    let invocationExtraBlocks: ContentBlock[] | undefined;
    let invocationGuardVerdict: GuardVerdict | undefined;
    let invocationSourceTruncations: ToolSourceTruncation[] = [];
    let refusalKind: RefusalKind | undefined;

    // Periodic heartbeat — keeps the dashboard StuckBanner alive during
    // long-running invocations (web_fetch, run_command, spawn_agent
    // parallel batches). Suppressed only for interactive waits or when no
    // progress sink is installed; explicitly unbounded work still heartbeats.
    const heartbeatSuppressed = interactive || !args.onToolProgress;
    let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
    if (!heartbeatSuppressed) {
      const intervalMs = args.toolProgressIntervalMs ?? 10_000;
      heartbeatTimer = setInterval(() => {
        args.onToolProgress!(tu.id, tu.name, Date.now() - t0, undefined, 'heartbeat');
      }, intervalMs);
    }

    // Delegate the timeout to the classification util. Interactive tools
    // (resolved via policy) opt out entirely. `resolveToolTimeoutMs` may
    // return Infinity (interactive/explicit only) — map that to 0
    // ("no timeout"), because `withAbortAndTimeout` treats ms<=0 as a no-op
    // whereas passing Infinity to setTimeout would fire almost immediately.
    const resolvedTimeout = tool ? resolveToolTimeoutMs(tool, normalizedInput) : NORMAL_TIMEOUT_MS;
    const toolTimeoutMs = (interactive || !Number.isFinite(resolvedTimeout)) ? 0 : resolvedTimeout;
    // ToolContext is a runtime boundary: worker structured cloning can turn an
    // AbortSignal into a truthy plain object. Ignore malformed values instead
    // of throwing before the invocation's guarded try/catch.
    const parentSignal = interactive ? undefined : asAbortSignal(args.toolContext.signal);
    const invocationAbort = interactive ? undefined : new AbortController();
    // Supervisor recovery — expose this call's controller so a stuck-tool
    // watcher can abort THIS invocation by tool_use_id. Interactive tools opt
    // out (they pause on user input, not a stuck signal).
    if (invocationAbort) args.registerInFlightTool?.(tu.id, invocationAbort);
    let relayParentAbort: (() => void) | undefined;
    let releaseUnsafe: (() => void) | undefined;
    let releaseOwnedByInvocation = false;
    if (invocationAbort && parentSignal) {
      relayParentAbort = (): void => {
        const reason = (parentSignal as { reason?: unknown }).reason;
        invocationAbort.abort(reason instanceof Error ? reason : new Error('parent aborted'));
      };
      if (parentSignal.aborted) relayParentAbort();
      else parentSignal.addEventListener('abort', relayParentAbort, { once: true });
    }

    try {
      const callContext: ToolContext = {
        ...args.toolContext,
        // Anchor for approval requests raised from nested contexts
        // (code_exec proxies receive this context as `ctx`).
        currentToolUseId: tu.id,
        parentToolUseId: tu.id,
        nestedToolObserver: args.makeNestedObserver?.(tu.id, tu.name),
        nestedCapabilityDispatch: {
          turn: args.turn,
          preflight: async (input) => {
            const pinDisabled = process.env.CODER_TOOL_PIN_DISABLE === '1';
            if (input.tool && args.isToolBlocked) {
              const blockedText = args.isToolBlocked(input.toolName);
              if (blockedText !== null) {
                return {
                  content: blockedText,
                  isError: true,
                  refusalKind: 'gate',
                };
              }
            }
            const hiddenFromModel =
              !pinDisabled
              && !!input.tool
              && !!args.visibleToolNames
              && !args.visibleToolNames.has(input.toolName)
              && !args.pinnedTools?.has(input.toolName);
            if (hiddenFromModel && input.toolName === 'create_goal') {
              const goal = args.toolContext.getGoalState?.();
              if (goal?.status === 'in_progress') {
                return {
                  content:
                    '[goal-gate] a goal is already in_progress — call update_goal to progress or complete it instead of creating a new one.',
                  isError: true,
                  refusalKind: 'gate',
                };
              }
            }
            const gateRefusal = await args.toolGate?.(input.toolName, input.toolInput) ?? null;
            if (gateRefusal !== null) {
              return { content: gateRefusal, isError: true, refusalKind: 'gate' };
            }
            const preReadRefusal = args.enforcePreRead?.(
              input.toolName,
              input.toolInput,
              input.turn,
              input.toolUseId,
            ) ?? null;
            const enforcePreReadResult =
              preReadRefusal !== null
              && (typeof preReadRefusal !== 'string' || dedupPolicyMode() === 'legacy');
            if (enforcePreReadResult) {
              const content = typeof preReadRefusal === 'string'
                ? preReadRefusal
                : preReadRefusal.content;
              const isError = typeof preReadRefusal === 'string'
                ? true
                : preReadRefusal.isError ?? true;
              return {
                content,
                isError,
                ...(isError ? { refusalKind: 'pre-read' } : {}),
              };
            }
            const taskModeRefusal =
              args.enforceTaskMode?.(input.toolName, input.toolMutates) ?? null;
            if (taskModeRefusal !== null) {
              return {
                content: taskModeRefusal,
                isError: true,
                refusalKind: 'task-mode',
              };
            }
            return null;
          },
          policyShadow: args.policyShadow,
          capabilityHooks: args.capabilityHooks,
        },
        signal: invocationAbort?.signal ?? parentSignal,
        reportProgress: (note: string) => {
          const trimmed = typeof note === 'string'
            ? (note.length > 200 ? note.slice(0, 200) + '...' : note)
            : '';
          args.onToolProgress?.(tu.id, tu.name, Date.now() - t0, trimmed, 'progress');
        },
        reportHeartbeat: (note?: string) => {
          const trimmed = typeof note === 'string'
            ? (note.length > 200 ? note.slice(0, 200) + '...' : note)
            : undefined;
          args.onToolProgress?.(tu.id, tu.name, Date.now() - t0, trimmed, 'heartbeat');
        },
      };
      // A4 — global tool timeout, resolved above via `resolveToolTimeoutMs`
      // (interactive/explicit Infinity → no timeout; slow tools → 30 min; else
      // 5 min). Abort signal applies in ALL cases except interactive tools
      // (which have their own pause/resume mechanism via provideUserInput).
      if (resolvedMetadata && (resolvedMetadata.mutates || !resolvedMetadata.parallelSafe)) {
        const reservation = args.toolContext.toolCallLedger?.reserveUnsafe(callContext.signal);
        if (reservation) {
          releaseUnsafe = await withAbortAndTimeout(reservation, {
            signal: callContext.signal,
            ms: toolTimeoutMs,
            label: `tool-lane:${tu.name}`,
          });
        }
      }
      const remainingToolTimeoutMs = toolTimeoutMs > 0
        ? Math.max(1, toolTimeoutMs - (Date.now() - t0))
        : 0;
      const rawInvocation = args.registry.invoke(tu.name, normalizedInput, callContext);
      if (releaseUnsafe) {
        releaseOwnedByInvocation = true;
        void rawInvocation.then(releaseUnsafe, releaseUnsafe);
      }
      const result = await withAbortAndTimeout(
        rawInvocation,
        {
          signal: callContext.signal,
          ms: remainingToolTimeoutMs,
          label: `tool:${tu.name}`,
        },
      );
      invocationContent = typeof result.content === 'string' ? result.content : String(result.content);
      invocationIsError = !!result.isError;
      invocationContentFormat = result.contentFormat ?? 'text';
      invocationStructuredData = result.structuredData;
      if (result.structuredData !== undefined) {
        try {
          invocationStructuredChars = JSON.stringify(result.structuredData)?.length ?? null;
        } catch {
          invocationStructuredChars = null;
        }
      }
      invocationExtraBlocks = result.extraUserBlocks;
      invocationGuardVerdict = result.guardVerdict;
      invocationSourceTruncations = normalizeSourceTruncations(result.sourceTruncations);
      if (invocationGuardVerdict?.action === 'block') {
        refusalKind = (invocationGuardVerdict.refusalKind as RefusalKind | undefined) ?? 'dedup';
        if (invocationGuardVerdict.shouldReflect) {
          toolLoopDetected = true;
          loopGuard = 'tuple-hash';
          loopDetail = {
            toolName: invocationGuardVerdict.sourceTool ?? tu.name,
            count: invocationGuardVerdict.count ?? 1,
          };
        }
      }
    } catch (e) {
      if (isTimeoutError(e)) {
        if (invocationAbort && !invocationAbort.signal.aborted) {
          try { invocationAbort.abort(e); } catch { /* ignore */ }
        }
        invocationContent =
          `[tool-timeout: \`${tu.name}\` exceeded ${e.ms}ms. ` +
          `Tune MCP_TOOL_NORMAL_TIMEOUT_MS / MCP_TOOL_SLOW_TIMEOUT_MS, or declare timeoutMs on the tool.]`;
        refusalKind = 'timeout';
      } else if (isAbortError(e)) {
        // A supervisor inject aborts the controller AND stashes a message —
        // surface it so the model sees WHY (timeout/stuck) and can adapt,
        // instead of the generic user/session abort text.
        const injected = args.consumeInjectedToolError?.(tu.id);
        invocationContent = injected ?? `[tool-aborted: \`${tu.name}\` cancelled by user/session.]`;
        refusalKind = 'abort';
      } else {
        invocationContent = e instanceof Error ? e.message : String(e);
      }
      invocationIsError = true;
    } finally {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      if (invocationAbort) args.unregisterInFlightTool?.(tu.id);
      if (relayParentAbort && parentSignal) {
        parentSignal.removeEventListener('abort', relayParentAbort);
      }
      if (releaseUnsafe && !releaseOwnedByInvocation) releaseUnsafe();
    }

    // Smart-reducer post-result. Tool-aware truncation that keeps the
    // most useful slices intact (git_log head, grep first matches, etc.)
    // before any generic truncation. Determinism is part of the contract.
    //
    // These three bridge hooks (reduce / post-process / polling-stuck) are
    // best-effort shaping. A throw here MUST NOT kill the turn: the
    // tool_result is already valid, just unshaped. Each is guarded so a
    // misbehaving host callback degrades to the pre-callback value instead
    // of escaping `dispatchTools` (which would propagate to the
    // orchestrator and abort the whole run).
    let shapedContent = invocationContent;
    let reductionReport: ReductionReport | undefined;
    try {
      const reduced = args.reduceToolResult?.(tu.name, invocationContent, {
        input: normalizedInput,
        isError: invocationIsError,
        contentFormat: invocationContentFormat,
      }) ?? invocationContent;
      if (typeof reduced === 'string') shapedContent = reduced;
      else {
        shapedContent = reduced.content;
        reductionReport = reduced.report;
      }
    } catch (e) {
      console.warn(`[coder/bt] reduceToolResult threw (${tu.name}): ${errText(e)} — using raw content`);
    }

    try {
      const postProcessed = args.postProcessToolResult?.({
        toolUseId: tu.id,
        name: tu.name,
        input: normalizedInput,
        rawContent: invocationContent,
        content: shapedContent,
        isError: invocationIsError,
        turn: args.turn,
      });
      if (postProcessed) {
        shapedContent = postProcessed.content;
        if (postProcessed.isError !== undefined) invocationIsError = postProcessed.isError;
      }
    } catch (e) {
      console.warn(`[coder/bt] postProcessToolResult threw (${tu.name}): ${errText(e)} — skipping post-process`);
    }

    // Polling-stuck detection. When a polling tool returns byte-identical
    // content N consecutive times the state isn't changing — replace with
    // a refusal so the agent stops burning tokens on dead polls.
    let stuckRefusal: string | null = null;
    try {
      stuckRefusal = args.detectPollingStuck?.(
        tu.name,
        shapedContent,
        invocationIsError,
        isRepeatable,
        args.turn,
      ) ?? null;
    } catch (e) {
      console.warn(`[coder/bt] detectPollingStuck threw (${tu.name}): ${errText(e)} — skipping`);
    }
    if (stuckRefusal !== null) {
      shapedContent = stuckRefusal;
      invocationIsError = true;
      refusalKind = 'polling-stuck';
      invocationGuardVerdict = {
        action: 'block',
        reason: 'polling-stuck',
        refusalKind: 'polling-stuck',
        shouldReflect: false,
        affectsFailureStreak: false,
        sourceTool: tu.name,
        originToolUseId: tu.id,
        stateEpoch: invocationGuard.stateEpoch,
      };
    }

    let finalContent = reminderPrefix + shapedContent;
    let finalIsError = invocationIsError;

    // PR 5 — failure-streak guard. After the call has settled (with
    // all post-processing applied) we record the success/failure and
    // decide whether the streak crossed a threshold. Mutates state in
    // place; verdict drives content rewrite + ToolLoopDetected routing.
    const affectsFailureStreak = invocationGuardVerdict
      ? invocationGuardVerdict.affectsFailureStreak !== false
      : true;
    if (args.failureStreakState && affectsFailureStreak) {
      const verdict: FailureStreakVerdict = checkFailureStreak({
        toolName: tu.name,
        isError: finalIsError,
        errorContent: shapedContent,
        turn: args.turn,
        state: args.failureStreakState,
        isRepeatable,
        // C2-b — opt-in error-signal classification (reset the streak when the
        // failure category changes). Off by default → identical legacy behavior.
        classifyErrors: process.env.CODER_FAILURE_CLASSIFICATION === '1',
      });
      if (verdict.kind === 'reminder') {
        finalContent =
          buildFailureStreakReminderMarker({ ...verdict, toolName: tu.name }) +
          '\n\n' + finalContent;
        args.onFailureStreakIntervention?.({
          toolName: tu.name,
          kind: 'reminder',
          count: verdict.count,
          firstFailureTurn: verdict.firstFailureTurn,
          lastError: verdict.lastError,
          turn: args.turn,
        });
      } else if (verdict.kind === 'refuse') {
        finalContent = buildFailureStreakRefusalText({ ...verdict, toolName: tu.name });
        finalIsError = true;
        refusalKind = 'failure-streak';
        toolLoopDetected = true;
        loopGuard = 'failure-streak';
        loopDetail = { toolName: tu.name, count: verdict.count };
        args.onFailureStreakIntervention?.({
          toolName: tu.name,
          kind: 'refuse',
          count: verdict.count,
          firstFailureTurn: verdict.firstFailureTurn,
          lastError: verdict.lastError,
          turn: args.turn,
        });
      }
    }

    let finalShaped = finalContent;
    let finalTruncated: boolean | undefined;
    let finalOriginalSize: number | undefined;
    let finalOutputId: string | undefined;
    let finalInlineCap: number | undefined;
    if (args.finalizeToolResult) {
      const fin = args.finalizeToolResult({
        toolName: tu.name,
        rawContent: invocationContent,
        shapedContent: finalContent,
        isError: finalIsError,
        reductionReport,
        sourceTruncations: invocationSourceTruncations,
      });
      finalShaped = fin.content;
      finalTruncated = fin.truncated;
      finalOriginalSize = fin.originalSize;
      finalOutputId = fin.outputId;
      finalInlineCap = fin.inlineCap;
      reductionReport = fin.reductionReport ?? reductionReport;
    }

    // Pin AFTER finalizeToolResult so the fail-safe cap can't truncate the
    // suffix away. Pins even on isError — the model's intent to use the
    // tool is what matters, and pinning stops repeated suffixes (the live
    // `pinnedTools` reference makes a second call in this batch non-hidden).
    if (hiddenFromModel) {
      const suffix =
        `\n\n[toolset] '${tu.name}' was not in your visible tool list; it executed anyway and is now pinned — it will appear in your tools from the next turn.`;
      const compactSuffix = `\n[toolset pinned: ${tu.name}]`;
      if (finalInlineCap == null || finalShaped.length + suffix.length <= finalInlineCap) {
        finalShaped += suffix;
      } else if (finalShaped.length + compactSuffix.length <= finalInlineCap) {
        finalShaped += compactSuffix;
      }
      args.onToolPinned?.(tu.name);
    }

    args.onToolCallFinalized?.(tu.id, finalShaped.length);
    const durationMs = Date.now() - t0;
    const ledgerEntry = args.toolContext.toolCallLedger?.record({
      name: tu.name,
      args: normalizedInput,
      content: finalShaped,
      isError: finalIsError,
      structuredData: invocationStructuredData,
      refusalKind,
      mutates: resolvedMetadata?.mutates ?? false,
      riskLevel: resolvedMetadata?.riskLevel,
      durationMs,
      executionClass: resolvedMetadata?.executionClass,
      repeatPolicy: resolvedMetadata?.repeatPolicy,
    });

    // A successful write/execute advances the shared workspace epoch. Local
    // stable caches are invalidated; an identical mutating signature keeps
    // only its own safety count so a third repeated mutation can still stop.
    const stateChangingSuccess =
      !finalIsError &&
      (
        resolvedMetadata?.repeatPolicy === 'mutating'
        || resolvedMetadata?.executionClass === 'write'
        || resolvedMetadata?.executionClass === 'execute'
      );
    if (stateChangingSuccess) {
      const sharedEpochBefore = args.noProgressTracker?.stateEpoch;
      args.noProgressTracker?.noteStateChange();
      if (sharedEpochBefore !== undefined && invocationGuard.stateEpoch !== sharedEpochBefore) {
        invocationGuard.syncEpoch(sharedEpochBefore);
      }
      invocationGuard.noteStateChange(verdict.key);
      reusableResults.clear();
    }

    const noProgressVerdict = args.noProgressTracker?.observe({
      name: tu.name,
      normalizedInput,
      content: finalShaped,
      isError: finalIsError,
      turn: args.turn,
      toolUseId: tu.id,
      repeatPolicy: resolvedMetadata?.repeatPolicy ?? 'stable',
      resultNovel: ledgerEntry?.resultNovel,
      coverageNovel: ledgerEntry?.coverageNovel,
      productive: stateChangingSuccess || ledgerEntry?.productive,
      stateEpoch: args.noProgressTracker.stateEpoch,
    }) ?? null;
    // Most unchanged reads remain observation-only: a later user request may
    // legitimately ask for the same snapshot. A small set of control-plane
    // tools can opt in when repeating an unchanged result inside the current
    // run is itself the failure mode (App Studio's workflow snapshot is the
    // motivating case). The successful third result is delivered, but the BT
    // is routed through Planning before another provider continuation.
    const stopRepeatedUnchangedResult =
      tool?.stopOnRepeatedUnchangedResult === true && noProgressVerdict?.wouldBlock === true;
    const effectiveNoProgressVerdict = stopRepeatedUnchangedResult
      ? {
          ...noProgressVerdict,
          action: 'block' as const,
          reason: 'cross-turn-no-progress-blocked',
          shouldReflect: true,
        }
      : noProgressVerdict;
    if (stopRepeatedUnchangedResult) {
      toolLoopDetected = true;
      loopGuard = 'doom-loop';
      loopDetail = { toolName: tu.name, count: noProgressVerdict.count ?? 3 };
    }
    const selectedGuardVerdict = invocationGuardVerdict
      ?? effectiveNoProgressVerdict
      ?? (verdict.action === 'allow' ? undefined : verdict);
    const finalGuardVerdict = selectedGuardVerdict && stateChangingSuccess
      ? { ...selectedGuardVerdict, stateEpoch: invocationGuard.stateEpoch }
      : selectedGuardVerdict;

    const dispatched: DispatchedToolResult = {
      toolUseId: tu.id,
      name: tu.name,
      content: finalShaped,
      rawChars: invocationContent.length,
      contentFormat: invocationContentFormat,
      structuredOutputChars: invocationStructuredChars,
      isError: finalIsError,
      durationMs,
      wasRefusedByDedup: false,
      refusalKind,
      extraUserBlocks: invocationExtraBlocks,
      ...(finalTruncated ? { truncated: true, originalSize: finalOriginalSize } : {}),
      ...(reductionReport ? { reductionReport } : {}),
      ...(finalOutputId ? { outputId: finalOutputId } : {}),
      ...(invocationSourceTruncations.length > 0
        ? { sourceTruncations: invocationSourceTruncations }
        : {}),
      ...(ledgerEntry ? { ledgerEntry } : {}),
      ...(finalGuardVerdict ? { guardVerdict: finalGuardVerdict } : {}),
      stateEpoch: invocationGuard.stateEpoch,
    };
    await pushResult(dispatched);

    if (
      !dispatched.isError &&
      !dispatched.extraUserBlocks &&
      resolvedMetadata?.repeatPolicy === 'stable' &&
      resolvedMetadata.executionClass === 'read' &&
      !interactive &&
      normalizedInput.force_reread !== true
    ) {
      reusableResults.set(
        `${verdict.key}|epoch:${invocationGuard.stateEpoch}`,
        { result: dispatched, count: 1 },
      );
    }
    } finally {
      if (args.capabilityHooks) {
        try {
          await args.capabilityHooks.after({
            ...hookBase,
            isError: hookResult?.isError ?? true,
            refused: hookResult?.refusalKind !== undefined,
            durationMs: hookResult?.durationMs ?? 0,
          });
        } catch {
          // Observation hooks never alter capability execution.
        }
      }
    }
  }

  // Early gates (disabled/goal/pre-read/task-mode/permission/dedup) converge
  // here so direct and nested calls share one complete accounting contract.
  for (const result of results) {
    result.stateEpoch ??= invocationGuard.stateEpoch;
    if (result.ledgerEntry) continue;
    const toolUse = args.toolUses.find((candidate) => candidate.id === result.toolUseId);
    const tool = lookupTool(args.registry, result.name);
    const normalizedInput = normalizeGuardInput(tool, toolUse?.input ?? {});
    const metadata = tool
      ? resolveToolInvocationMetadata(tool, normalizedInput)
      : null;
    const entry = args.toolContext.toolCallLedger?.record({
      name: result.name,
      args: normalizedInput,
      content: result.content,
      isError: result.isError,
      refusalKind: result.refusalKind,
      mutates: metadata?.mutates ?? false,
      riskLevel: metadata?.riskLevel,
      durationMs: result.durationMs,
      executionClass: metadata?.executionClass,
      repeatPolicy: metadata?.repeatPolicy,
    });
    if (entry) result.ledgerEntry = entry;
  }

  return { results, toolLoopDetected, loopGuard, loopDetail };
}

/** Compact error-to-string for the guarded bridge-callback warnings. */
function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Tolerant registry lookup. Different `ToolRegistry` implementations may
 * expose `.get(name)`, `.list()`, or `.has(name)`. Read via `.list()` so we
 * don't depend on a method that some test stubs omit.
 */
function lookupTool(registry: ToolRegistry, name: string): CoderTool | null {
  try {
    const list = registry.list();
    for (const t of list) {
      if (t.name === name) return t;
    }
  } catch {
    // ignore — fall through
  }
  return null;
}

export function toToolResultBlock(r: DispatchedToolResult): ContentBlock {
  return {
    type: 'tool_result',
    tool_use_id: r.toolUseId,
    content: r.content,
    is_error: r.isError,
    ...(r.truncated ? { truncated: true, originalSize: r.originalSize } : {}),
  };
}

export function buildToolMessage(results: DispatchedToolResult[]): AgentMessage {
  return {
    role: 'tool',
    content: results.map(toToolResultBlock),
  };
}
