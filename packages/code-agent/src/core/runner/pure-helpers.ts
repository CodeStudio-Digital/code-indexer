import type { AgentMessage } from '@mcp/code-agent/core/messages.js';

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

/**
 * Coarse character count over a transcript. Adds a fixed per-block
 * overhead and counts string fields on `content` / `text` / `input`.
 * NOT exact tokens, but good enough as a budget gauge.
 */
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
 * Decide whether a tool result should be spilled to the side-file store
 * (`ToolOutputStore`) so the agent can recover the full content later via
 * `get_tool_output(id)`. Two triggers:
 *
 *   1. **Size**: content exceeds the push-time cap (would otherwise be
 *      truncated to head + marker by buildToolResultBlock).
 *   2. **Failure**: the call returned an error, regardless of size.
 *      Short failure lines ("FAILED tests/foo.py::bar") routinely hide
 *      the full stack trace behind a smart-reducer or truncation marker
 *      — preserving the raw output unconditionally on isError lets the
 *      agent inspect the trace without rerunning the failing command.
 *
 * Extracted from the runner's tool-dispatch loop (around the
 * `toolResultBlocks.push(buildToolResultBlock(...))` site) to keep the
 * spill condition independently testable. Pure function — caller still
 * gates on `toolOutputStore` availability separately.
 */
export function shouldSpillToolOutput(
  result: { content: string; isError?: boolean },
  cap: number,
): boolean {
  return result.content.length > cap || !!result.isError;
}
