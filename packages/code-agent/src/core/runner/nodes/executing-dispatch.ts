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
  enforcePreRead?: (toolName: string, input: unknown, turn: number) => string | null;
  /**
   * Task-mode gate — enforces `execution_mode='all-subagent'` by refusing
   * mutating tools that would bypass `execute_task`. Pure consult; no
   * dedup counter side-effect.
   */
  enforceTaskMode?: (toolName: string, toolMutates: boolean) => string | null;
  /** Smart-reducer applied to the raw result content before push. */
  reduceToolResult?: (toolName: string, content: string) => string;
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
  onToolProgress?: (id: string, name: string, elapsedMs: number) => void;
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
    const preReadRefusal = args.enforcePreRead?.(tu.name, tu.input, args.turn) ?? null;
    if (preReadRefusal !== null) {
      results.push({
        toolUseId: tu.id,
        name: tu.name,
        content: preReadRefusal,
        isError: true,
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

    try {
      const result = await args.registry.invoke(tu.name, tu.input, args.toolContext);
      invocationContent = typeof result.content === 'string' ? result.content : String(result.content);
      invocationIsError = !!result.isError;
    } catch (e) {
      invocationContent = e instanceof Error ? e.message : String(e);
      invocationIsError = true;
    } finally {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
    }

    // Smart-reducer post-result. Tool-aware truncation that keeps the
    // most useful slices intact (git_log head, grep first matches, etc.)
    // before any generic truncation. Determinism is part of the contract.
    let shapedContent = args.reduceToolResult?.(tu.name, invocationContent) ?? invocationContent;

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
