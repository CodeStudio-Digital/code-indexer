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

export interface DispatchedToolResult {
  toolUseId: string;
  name: string;
  content: string;
  isError: boolean;
  durationMs: number;
  /** True when synthesized by the dedup refusal path (no real invocation). */
  wasRefusedByDedup: boolean;
}

export interface DispatchArgs {
  toolUses: Array<{ id: string; name: string; input: Record<string, unknown> }>;
  registry: ToolRegistry;
  toolContext: ToolContext;
  turn: number;
  dupCalls: Map<string, DupCallEntry>;
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
}

export async function dispatchTools(args: DispatchArgs): Promise<DispatchResult> {
  const results: DispatchedToolResult[] = [];
  let toolLoopDetected = false;
  // PR 5 — which guard fired last. Tracked so the Executing node can
  // surface the correct guard kind to the orchestrator.
  let loopGuard: DispatchResult['loopGuard'] | undefined;

  for (const tu of args.toolUses) {
    const tool = lookupTool(args.registry, tu.name);
    const isRepeatable = !!tool?.repeatable;
    // Interactivity comes from the policy classification, NOT the raw tool
    // object: the built-in interactive tools (submit_plan, ask_user,
    // submit_tasks, submit_spec, master variants) declare `interactive` in
    // `policy.ts`'s BUILTIN_CLASSIFICATION, not on their CoderTool.
    const interactive = tool ? resolveToolMetadata(tool).interactive : false;

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
      });
      toolLoopDetected = true;
      loopGuard = 'tuple-hash';
      continue;
    }

    const reminderPrefix = verdict.kind === 'allow-with-reminder' ? verdict.reminderText : '';
    // Telemetry: signal start BEFORE invoking so the dashboard can render
    // "tool in flight" the moment the call is dispatched.
    args.onToolCallStart?.(tu.id, tu.name, tu.input);
    const t0 = Date.now();
    let invocationContent: string;
    let invocationIsError = false;

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
    } catch (e) {
      if (isTimeoutError(e)) {
        if (invocationAbort && !invocationAbort.signal.aborted) {
          try { invocationAbort.abort(e); } catch { /* ignore */ }
        }
        invocationContent =
          `[tool-timeout: \`${tu.name}\` exceeded ${e.ms}ms. ` +
          `Tune MCP_TOOL_NORMAL_TIMEOUT_MS / MCP_TOOL_SLOW_TIMEOUT_MS, or declare timeoutMs on the tool.]`;
      } else if (isAbortError(e)) {
        invocationContent = `[tool-aborted: \`${tu.name}\` cancelled by user/session.]`;
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

    args.onToolCallFinalized?.(tu.id, finalContent.length);
    results.push({
      toolUseId: tu.id,
      name: tu.name,
      content: finalContent,
      isError: finalIsError,
      durationMs: Date.now() - t0,
      wasRefusedByDedup: false,
    });
  }

  return { results, toolLoopDetected, loopGuard };
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
  };
}

export function buildToolMessage(results: DispatchedToolResult[]): AgentMessage {
  return {
    role: 'tool',
    content: results.map(toToolResultBlock),
  };
}
