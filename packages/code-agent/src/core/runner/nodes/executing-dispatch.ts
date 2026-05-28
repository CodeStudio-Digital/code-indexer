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
import type { DupCallEntry } from '../machine/types.js';
import { withAbortAndTimeout, isTimeoutError, isAbortError } from './executing-abort.js';

/**
 * Hard upper bound on a single tool invocation. Catches misbehaving MCP
 * tools that have no `timeoutMs` declared and would otherwise wedge the
 * Executing node forever (the Camada 1 heartbeat surfaces "still running"
 * but cannot cancel). Tools explicitly marked `interactive: true` or
 * `timeoutMs: Infinity` are exempt — they legitimately wait on humans /
 * cooperative polling.
 */
const DEFAULT_TOOL_TIMEOUT_MS = (() => {
  const v = process.env.CODER_TOOL_DEFAULT_TIMEOUT_MS;
  if (v != null && v !== '') {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 300_000; // 5 minutes
})();

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
}

export interface DispatchResult {
  results: DispatchedToolResult[];
  /** True when at least one call was refused — caller routes to Planning. */
  toolLoopDetected: boolean;
}

export async function dispatchTools(args: DispatchArgs): Promise<DispatchResult> {
  const results: DispatchedToolResult[] = [];
  let toolLoopDetected = false;

  for (const tu of args.toolUses) {
    const tool = lookupTool(args.registry, tu.name);
    const isRepeatable = !!tool?.repeatable;

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
    const heartbeatSuppressed =
      tool?.interactive === true || tool?.timeoutMs === Infinity || !args.onToolProgress;
    let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
    if (!heartbeatSuppressed) {
      const intervalMs = args.toolProgressIntervalMs ?? 10_000;
      heartbeatTimer = setInterval(() => {
        args.onToolProgress!(tu.id, tu.name, Date.now() - t0);
      }, intervalMs);
    }

    const noTimeout = tool?.interactive === true || tool?.timeoutMs === Infinity;
    const toolTimeoutMs = noTimeout
      ? 0
      : (typeof tool?.timeoutMs === 'number' && tool.timeoutMs > 0
          ? tool.timeoutMs
          : DEFAULT_TOOL_TIMEOUT_MS);
    const parentSignal = tool?.interactive === true ? undefined : args.toolContext.signal;
    const invocationAbort = tool?.interactive === true ? undefined : new AbortController();
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
      // A4 — global tool timeout. Resolve precedence:
      //   1. tool.timeoutMs === Infinity → no timeout (cooperative polling)
      //   2. tool.interactive === true   → no timeout (waiting on human)
      //   3. tool.timeoutMs > 0           → use it (per-tool override)
      //   4. otherwise                    → DEFAULT_TOOL_TIMEOUT_MS (5min)
      // Abort signal applies in ALL cases except `interactive: true`
      // (which has its own pause mechanism via provideUserInput).
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
          `Override via CODER_TOOL_DEFAULT_TIMEOUT_MS or declare timeoutMs on the tool.]`;
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
    let shapedContent = args.reduceToolResult?.(tu.name, invocationContent) ?? invocationContent;

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

    // Polling-stuck detection. When a polling tool returns byte-identical
    // content N consecutive times the state isn't changing — replace with
    // a refusal so the agent stops burning tokens on dead polls.
    const stuckRefusal = args.detectPollingStuck?.(
      tu.name,
      shapedContent,
      invocationIsError,
      isRepeatable,
      args.turn,
    ) ?? null;
    if (stuckRefusal !== null) {
      shapedContent = stuckRefusal;
      invocationIsError = true;
    }

    const finalContent = reminderPrefix + shapedContent;
    args.onToolCallFinalized?.(tu.id, finalContent.length);
    results.push({
      toolUseId: tu.id,
      name: tu.name,
      content: finalContent,
      isError: invocationIsError,
      durationMs: Date.now() - t0,
      wasRefusedByDedup: false,
    });
  }

  return { results, toolLoopDetected };
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
