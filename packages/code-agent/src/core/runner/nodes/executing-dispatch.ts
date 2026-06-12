/**
 * Tool dispatch with tuple-hash guard. Walks the assistant's emitted
 * tool_use blocks serially:
 *
 *   1. Look up the CoderTool to read its `repeatable` flag.
 *   2. Run `checkDupCall` — verdict decides what happens:
 *        - allow            → registry.invoke → wrap result
 *        - allow-with-rmd   → registry.invoke → prepend system-reminder
 *        - refuse           → synthesize error result, set tool-loop flag
 *   3. Build a single tool-role AgentMessage with all the tool_result
 *      blocks so the next turn sees them as one atomic batch.
 *
 * Serial (not parallel) by design: tools may share filesystem state and
 * parallel dispatch was the source of several "two writes raced" bugs in
 * the legacy loop. If we want parallelism later, it goes per-tool via an
 * allowlist (e.g. read-only tools only).
 */
import type { AgentMessage, ContentBlock } from '@mcp/code-agent/core/messages.js';
import type { ToolRegistry } from '@mcp/code-agent/core/registry.js';
import type { ToolContext, CoderTool } from '@mcp/code-agent/core/tool.js';
import { checkDupCall } from '../guards/tuple-hash-dedup.js';
import {
  checkFailureStreak,
  buildFailureStreakReminderMarker,
  buildFailureStreakRefusalText,
  type FailureStreakState,
  type FailureStreakVerdict,
} from '../guards/failure-streak.js';
import type { DupCallEntry } from '../machine/types.js';
import { withAbortAndTimeout, isTimeoutError, isAbortError } from './executing-abort.js';
import { resolveToolMetadata } from '../../policy.js';
import { resolveToolTimeoutMs, NORMAL_TIMEOUT_MS } from '../../tool-timeouts.js';

/**
 * Per-invocation timeout is delegated to `resolveToolTimeoutMs` (the
 * `core/tool-timeouts.ts` classification): interactive/repeatable tools get
 * no timeout; known-slow tools (subagents, code_exec, run_command, research,
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
  /** Set by the live finalize hook when the fail-safe cap truncated content. */
  truncated?: boolean;
  originalSize?: number;
}

export interface DispatchArgs {
  toolUses: Array<{ id: string; name: string; input: Record<string, unknown> }>;
  registry: ToolRegistry;
  toolContext: ToolContext;
  turn: number;
  dupCalls: Map<string, DupCallEntry>;
  /**
   * Cross-cycle loop-refusal counter (`ctx.loopRefusals`). Survives the
   * per-Planning `dupCalls` reset, so it remembers a refused call that keeps
   * coming back. When a tool+args crosses `ENFORCE_AFTER_REFUSALS`, the
   * result's `loopEnforcement` is set so the Executing node injects an active
   * enforcement reminder. Omit to disable (tests / subagent paths).
   */
  loopRefusals?: Map<string, number>;
  /**
   * Optional pre-dispatch gate. Returning a non-null string blocks the
   * invocation and synthesises an error tool_result carrying that text
   * (plan/spec mode + mutating tool, sandbox required, etc.). Runs
   * BEFORE the tuple-hash check so a blocked call doesn't pollute the
   * dedup counter.
   */
  toolGate?: (toolName: string, input: unknown) => string | null;
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
  /** Smart-reducer applied to the raw result content before push. */
  reduceToolResult?: (toolName: string, content: string) => string;
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
  }) => { content: string; truncated?: boolean; originalSize?: number };
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
  onToolProgress?: (id: string, name: string, elapsedMs: number, note?: string) => void;
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
   * parents (and when nested guards are enabled). The observer closes over
   * the run's `dupCalls`/`failureStreaks`, so nested calls count against the
   * SAME guard state as direct ones.
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
  loopGuard?: 'tuple-hash' | 'failure-streak';
  /**
   * Set when a tool+args was hard-refused enough times across planning
   * cycles (≥ `ENFORCE_AFTER_REFUSALS`) to count as an INSISTENT loop. The
   * Executing node reacts by injecting an active enforcement
   * `<system-reminder>` (available tools + "stop looping") and emitting
   * `tool_loop_intervention { kind: 'loop-enforced' }`. Last one in the
   * batch wins (mirrors `loopGuard`).
   */
  loopEnforcement?: { toolName: string; count: number };
}

/**
 * How many cross-cycle hard refusals of the same tool+args trigger active
 * enforcement. 2 ≈ ~6 identical calls (each refuse follows a 2nd reminder),
 * i.e. the agent burned two full clean-slate cycles still repeating itself.
 */
const ENFORCE_AFTER_REFUSALS = 2;

export async function dispatchTools(args: DispatchArgs): Promise<DispatchResult> {
  const results: DispatchedToolResult[] = [];
  let toolLoopDetected = false;
  // PR 5 — which guard fired last. Tracked so the Executing node can
  // surface the correct guard kind to the orchestrator.
  let loopGuard: DispatchResult['loopGuard'] | undefined;
  // Insistent-loop enforcement signal (last refused call that crossed the
  // cross-cycle threshold wins).
  let loopEnforcement: DispatchResult['loopEnforcement'];

  for (const tu of args.toolUses) {
    const tool = lookupTool(args.registry, tu.name);
    const isRepeatable = !!tool?.repeatable;
    // Interactivity comes from the policy classification, NOT the raw tool
    // object: the built-in interactive tools (submit_plan, ask_user,
    // submit_tasks, submit_spec, master variants) declare `interactive` in
    // `policy.ts`'s BUILTIN_CLASSIFICATION, not on their CoderTool.
    const interactive = tool ? resolveToolMetadata(tool).interactive : false;

    // Hidden-call handling (pin mechanism). A registered tool can be absent
    // from the model's visible list (tier-hidden or cap-cut) yet still be
    // called by name — find_tools tells the model to do exactly that.
    // Policy: disabled tools hard-block; goal-gated create_goal refuses
    // with redirection; everything else flows through ALL the gates below,
    // executes, and is pinned at the result tail.
    const pinDisabled = process.env.CODER_TOOL_PIN_DISABLE === '1';
    if (!pinDisabled && tool && args.isToolBlocked) {
      const blockedText = args.isToolBlocked(tu.name);
      if (blockedText !== null) {
        results.push({
          toolUseId: tu.id,
          name: tu.name,
          content: blockedText,
          isError: true,
          durationMs: 0,
          wasRefusedByDedup: false,
          refusalKind: 'gate',
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
        results.push({
          toolUseId: tu.id,
          name: tu.name,
          content:
            '[goal-gate] a goal is already in_progress — call update_goal to progress or complete it instead of creating a new one.',
          isError: true,
          durationMs: 0,
          wasRefusedByDedup: false,
          refusalKind: 'gate',
        });
        continue;
      }
    }

    // Pre-dispatch gate (plan/spec/policy refusal). Synthesises an error
    // tool_result without touching the dedup counter — the call never
    // happened from the agent's POV.
    const gateRefusal = args.toolGate?.(tu.name, tu.input) ?? null;
    if (gateRefusal !== null) {
      results.push({
        toolUseId: tu.id,
        name: tu.name,
        content: gateRefusal,
        isError: true,
        durationMs: 0,
        wasRefusedByDedup: false,
        refusalKind: 'gate',
      });
      continue;
    }

    // Pre-read enforcement (Row 32 from agent-research comparisons).
    // Refuses re-reads BEFORE the dedup check so the dedup counter
    // stays meaningful only for non-read tools.
    const preReadRefusal = args.enforcePreRead?.(tu.name, tu.input, args.turn, tu.id) ?? null;
    if (preReadRefusal !== null) {
      const content = typeof preReadRefusal === 'string' ? preReadRefusal : preReadRefusal.content;
      const isError = typeof preReadRefusal === 'string' ? true : preReadRefusal.isError ?? true;
      results.push({
        toolUseId: tu.id,
        name: tu.name,
        content,
        isError,
        durationMs: 0,
        wasRefusedByDedup: false,
        // The auto-downgrade variant (isError=false) is a degraded SUCCESS,
        // not a refusal — leave it untagged so error analytics stay clean.
        ...(isError ? { refusalKind: 'pre-read' as const } : {}),
      });
      continue;
    }

    // Task-mode gate (execution_mode='all-subagent'). Refuses mutating
    // tools that would bypass the task workflow. Runs AFTER pre-read so
    // a write that would have been pre-read-refused stays on that
    // (clearer) error path, and BEFORE the tuple-hash so the dedup
    // counter isn't polluted by gate-blocked calls.
    const toolMutates = tool?.mutates ?? (tool?.source === 'mcp_external');
    const taskModeRefusal = args.enforceTaskMode?.(tu.name, !!toolMutates) ?? null;
    if (taskModeRefusal !== null) {
      results.push({
        toolUseId: tu.id,
        name: tu.name,
        content: taskModeRefusal,
        isError: true,
        durationMs: 0,
        wasRefusedByDedup: false,
        refusalKind: 'task-mode',
      });
      continue;
    }

    const verdict = checkDupCall({
      name: tu.name,
      input: tu.input,
      isRepeatable,
      turn: args.turn,
      useId: tu.id,
      dupCalls: args.dupCalls,
    });

    if (verdict.kind === 'refuse') {
      results.push({
        toolUseId: tu.id,
        name: tu.name,
        content: verdict.refuseText,
        isError: true,
        durationMs: 0,
        wasRefusedByDedup: true,
        refusalKind: 'dedup',
      });
      toolLoopDetected = true;
      loopGuard = 'tuple-hash';
      // Cross-cycle memory: the Planning reset clears `dupCalls`, so without
      // this the loop never escalates past one passive refusal. Count refusals
      // that survive the reset; once they pile up, flag active enforcement.
      if (args.loopRefusals) {
        const n = (args.loopRefusals.get(verdict.key) ?? 0) + 1;
        args.loopRefusals.set(verdict.key, n);
        if (n >= ENFORCE_AFTER_REFUSALS) loopEnforcement = { toolName: tu.name, count: n };
      }
      continue;
    }

    const reminderPrefix = verdict.kind === 'allow-with-reminder' ? verdict.reminderText : '';
    // Telemetry: signal start BEFORE invoking so the dashboard can render
    // "tool in flight" the moment the call is dispatched.
    args.onToolCallStart?.(tu.id, tu.name, tu.input);

    // Permission gate (modes 'ask'/'auto') — may pause awaiting user
    // approval. Sits AFTER onToolCallStart (the dashboard block must exist
    // as the anchor for the approval card) and BEFORE the duration clock,
    // heartbeat and timeout wrappers (decision time is free; a long pause
    // must not be killed by toolTimeoutMs). Runs after checkDupCall so the
    // user is never asked to approve a call the dedup guard would refuse.
    // A denial synthesizes an error result without touching the dedup or
    // failure-streak state — mirrors the toolGate refusal shape above.
    const permissionGate = args.toolContext.permissionGate;
    if (permissionGate) {
      const decision = await permissionGate.check({
        toolUseId: tu.id,
        toolName: tu.name,
        input: tu.input,
        tool: tool ?? undefined,
        parentToolUseId: args.toolContext.approvalAnchorId,
        turn: args.turn,
      });
      if (!decision.allowed) {
        results.push({
          toolUseId: tu.id,
          name: tu.name,
          content: decision.refusalText,
          isError: true,
          durationMs: 0,
          wasRefusedByDedup: false,
          refusalKind: 'user_denied',
        });
        continue;
      }
    }

    const t0 = Date.now();
    let invocationContent: string;
    let invocationIsError = false;
    let invocationExtraBlocks: ContentBlock[] | undefined;
    let refusalKind: RefusalKind | undefined;

    // Periodic heartbeat — keeps the dashboard StuckBanner alive during
    // long-running invocations (web_fetch, run_command, spawn_agent
    // parallel batches). Suppressed for `interactive: true` (waiting for
    // user input) and `timeoutMs: Infinity` (legitimately long polling).
    const heartbeatSuppressed = interactive || !args.onToolProgress;
    let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
    if (!heartbeatSuppressed) {
      const intervalMs = args.toolProgressIntervalMs ?? 10_000;
      heartbeatTimer = setInterval(() => {
        args.onToolProgress!(tu.id, tu.name, Date.now() - t0);
      }, intervalMs);
    }

    // Delegate the timeout to the classification util. Interactive tools
    // (resolved via policy) opt out entirely. `resolveToolTimeoutMs` may
    // return Infinity (interactive/repeatable/explicit) — map that to 0
    // ("no timeout"), because `withAbortAndTimeout` treats ms<=0 as a no-op
    // whereas passing Infinity to setTimeout would fire almost immediately.
    const resolvedTimeout = tool ? resolveToolTimeoutMs(tool) : NORMAL_TIMEOUT_MS;
    const toolTimeoutMs = (interactive || !Number.isFinite(resolvedTimeout)) ? 0 : resolvedTimeout;
    const parentSignal = interactive ? undefined : args.toolContext.signal;
    const invocationAbort = interactive ? undefined : new AbortController();
    let relayParentAbort: (() => void) | undefined;
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
        signal: invocationAbort?.signal ?? parentSignal,
        reportProgress: (note: string) => {
          const trimmed = typeof note === 'string'
            ? (note.length > 200 ? note.slice(0, 200) + '...' : note)
            : '';
          args.onToolProgress?.(tu.id, tu.name, Date.now() - t0, trimmed);
        },
      };
      // A4 — global tool timeout, resolved above via `resolveToolTimeoutMs`
      // (interactive/repeatable → no timeout; slow tools → 30 min; else
      // 5 min). Abort signal applies in ALL cases except interactive tools
      // (which have their own pause/resume mechanism via provideUserInput).
      const result = await withAbortAndTimeout(
        args.registry.invoke(tu.name, tu.input, callContext),
        {
          signal: callContext.signal,
          ms: toolTimeoutMs,
          label: `tool:${tu.name}`,
        },
      );
      invocationContent = typeof result.content === 'string' ? result.content : String(result.content);
      invocationIsError = !!result.isError;
      invocationExtraBlocks = result.extraUserBlocks;
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
        invocationContent = `[tool-aborted: \`${tu.name}\` cancelled by user/session.]`;
        refusalKind = 'abort';
      } else {
        invocationContent = e instanceof Error ? e.message : String(e);
      }
      invocationIsError = true;
    } finally {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      if (relayParentAbort && parentSignal) {
        parentSignal.removeEventListener('abort', relayParentAbort);
      }
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
    try {
      shapedContent = args.reduceToolResult?.(tu.name, invocationContent) ?? invocationContent;
    } catch (e) {
      console.warn(`[coder/bt] reduceToolResult threw (${tu.name}): ${errText(e)} — using raw content`);
    }

    try {
      const postProcessed = args.postProcessToolResult?.({
        toolUseId: tu.id,
        name: tu.name,
        input: tu.input,
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
    }

    let finalContent = reminderPrefix + shapedContent;
    let finalIsError = invocationIsError;

    // PR 5 — failure-streak guard. After the call has settled (with
    // all post-processing applied) we record the success/failure and
    // decide whether the streak crossed a threshold. Mutates state in
    // place; verdict drives content rewrite + ToolLoopDetected routing.
    if (args.failureStreakState) {
      const verdict: FailureStreakVerdict = checkFailureStreak({
        toolName: tu.name,
        isError: finalIsError,
        errorContent: shapedContent,
        turn: args.turn,
        state: args.failureStreakState,
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
    if (args.finalizeToolResult) {
      const fin = args.finalizeToolResult({
        toolName: tu.name,
        rawContent: invocationContent,
        shapedContent: finalContent,
        isError: finalIsError,
      });
      finalShaped = fin.content;
      finalTruncated = fin.truncated;
      finalOriginalSize = fin.originalSize;
    }

    // Pin AFTER finalizeToolResult so the fail-safe cap can't truncate the
    // suffix away. Pins even on isError — the model's intent to use the
    // tool is what matters, and pinning stops repeated suffixes (the live
    // `pinnedTools` reference makes a second call in this batch non-hidden).
    if (hiddenFromModel) {
      finalShaped +=
        `\n\n[toolset] '${tu.name}' was not in your visible tool list; it executed anyway and is now pinned — it will appear in your tools from the next turn.`;
      args.onToolPinned?.(tu.name);
    }

    args.onToolCallFinalized?.(tu.id, finalShaped.length);
    results.push({
      toolUseId: tu.id,
      name: tu.name,
      content: finalShaped,
      rawChars: invocationContent.length,
      isError: finalIsError,
      durationMs: Date.now() - t0,
      wasRefusedByDedup: false,
      refusalKind,
      extraUserBlocks: invocationExtraBlocks,
      ...(finalTruncated ? { truncated: true, originalSize: finalOriginalSize } : {}),
    });
  }

  return { results, toolLoopDetected, loopGuard, loopEnforcement };
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
