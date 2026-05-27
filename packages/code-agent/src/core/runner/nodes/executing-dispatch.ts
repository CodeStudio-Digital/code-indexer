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
    const t0 = Date.now();
    let invocationContent: string;
    let invocationIsError = false;

    try {
      const result = await args.registry.invoke(tu.name, tu.input, args.toolContext);
      invocationContent = typeof result.content === 'string' ? result.content : String(result.content);
      invocationIsError = !!result.isError;
    } catch (e) {
      invocationContent = e instanceof Error ? e.message : String(e);
      invocationIsError = true;
    }

    results.push({
      toolUseId: tu.id,
      name: tu.name,
      content: reminderPrefix + invocationContent,
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
