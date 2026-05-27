/**
 * Helper functions extracted from `executing.ts` to keep the main node
 * body lean. Pure (or near-pure) functions:
 *   - `decideTerminal` — pick the next BT event after a tool-bearing turn
 *     considering max-turns + auto-continue policy.
 *   - `runQualityCheck` — fire-and-forget bridge call with input enrichment.
 *   - `joinText` / `providerErrorEvent` / `inferStatus` — utilities.
 */
import type { BehaviorEvent, RunContext } from '../machine/types.js';
import { events } from '../machine/events.js';
import { checkMaxTurns, maxAutoContinues } from '../guards/max-turns.js';

const DEBUG = process.env.CODER_BT_DEBUG === '1';

/**
 * Decide the terminal event for a turn that produced tool calls. Applies
 * the max-turns guard: continue, auto-continue (with recap reminder), or
 * stop with `MaxTurnsReached`.
 */
export function decideTerminal(ctx: RunContext): BehaviorEvent {
  const maxTurns = ctx.opts.maxTurns ?? 50;
  const verdict = checkMaxTurns({
    turn: ctx.turn,
    autoContinues: ctx.autoContinues,
    maxTurns,
  });

  if (verdict.kind === 'continue') {
    return events.turnSucceeded({ hasToolCalls: true });
  }

  if (verdict.kind === 'auto-continue') {
    ctx.autoContinues = verdict.nextCount;
    ctx.emit('auto_continue', verdict.nextCount, maxAutoContinues());
    // Append a recap reminder so the model knows it has extra headroom.
    ctx.messages.push({
      role: 'user',
      content: [
        {
          type: 'text',
          text:
            `<system-reminder>auto-continue ${verdict.nextCount}/${maxAutoContinues()} — ` +
            `you crossed maxTurns=${maxTurns}. Wrap up the in-flight work; ` +
            `do not start new investigations.</system-reminder>`,
        },
      ],
    });
    return events.turnSucceeded({ hasToolCalls: false });
  }

  // verdict.kind === 'stop'
  ctx.stopReason = 'max_turns';
  return events.maxTurnsReached({ autoContinueLeft: 0 });
}

/**
 * Fire the bridge's quality watchdog hook. Enriches each tool result with
 * its original input so `recordToolCallsForWatchdog` can record meaningful
 * argsPreview. Never throws — synchronous exceptions are swallowed.
 */
export function runQualityCheck(
  ctx: RunContext,
  assistantText: string,
  toolResults: Array<{ name: string; content: string; isError: boolean }>,
  toolUses: Array<{ id: string; name: string; input: Record<string, unknown> }>,
): void {
  if (!ctx.bridge?.runQualityCheck) return;
  const enriched = toolResults.map((r) => {
    const tu = toolUses.find((t) => t.name === r.name);
    return { name: r.name, input: tu?.input ?? {}, content: r.content, isError: r.isError };
  });
  try {
    ctx.bridge.runQualityCheck({
      turn: ctx.turn,
      assistantText,
      toolResults: enriched,
    });
  } catch (e) {
    if (DEBUG) console.log('[bt-debug] runQualityCheck threw synchronously (ignored)', e);
  }
}

export function joinText(blocks: string[]): string {
  return blocks.filter(Boolean).join(' ').trim();
}

export function providerErrorEvent(e: unknown): BehaviorEvent {
  const status = inferStatus(e);
  return events.providerError({
    retryable: status >= 500 || status === 429 || status === 401,
    status,
  });
}

function inferStatus(e: unknown): number {
  if (e && typeof e === 'object') {
    const s = (e as { status?: number }).status;
    if (typeof s === 'number') return s;
  }
  return 500;
}
