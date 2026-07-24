/**
 * Planning node — entered after a loop guard (tuple-hash dedup, doom-loop,
 * dominance, failure-streak) emits `ToolLoopDetected`. Behavior:
 *
 *   1. Push a one-shot reflection `<system-reminder>` naming WHICH guard
 *      fired (tool + count when the event carries them) and directing a
 *      strategy change before the next tool batch. Without this the model
 *      re-entered Executing with zero steering and usually replayed the
 *      same call. This reminder is the complete reflection path; tuple
 *      refusal counters are no longer retained across planning cycles.
 *   2. Reset the legacy rollback-only dedup table. Hybrid invocation state is
 *      local to a batch/code_exec and therefore needs no cross-turn retention.
 *   2b. Reset the failure-streak table too. This is the documented "clears
 *      both together" contract (nested-observer.ts): without it, a tool that
 *      crossed the refuse threshold inside a code_exec script was pre-refused
 *      for the rest of the run (it can never succeed to clear itself), so a
 *      later legitimately-needed retry was permanently blocked.
 *   2c. Clear unchanged-result observations. An active no-progress break has
 *      already reflected once; retaining it would penalize a later user
 *      request that legitimately asks for the same snapshot.
 *   3. Record the trigger reason in `ctx.transition` for `RunResult`
 *      attribution.
 */
import type { BehaviorEvent, BehaviorNode, RunContext } from '../machine/types.js';
import type { TransitionKind } from '../types.js';
import { events } from '../machine/events.js';
import { resetDupCalls } from '../guards/tuple-hash-dedup.js';
import { resetFailureStreaks } from '../guards/failure-streak.js';
import { buildLoopGuardReflectionMarker } from '../markers.js';

export class PlanningNode implements BehaviorNode {
  readonly state = 'Planning' as const;

  async execute(ctx: RunContext, lastEvent: BehaviorEvent | null): Promise<BehaviorEvent> {
    const loopEvent = lastEvent?.kind === 'ToolLoopDetected' ? lastEvent : null;

    // No offending signature survives Planning. In the hybrid policy the
    // invocation state was already local; this only clears legacy rollback.
    resetDupCalls(ctx.dupCalls);
    // Clear the per-tool failure streaks too (see nested-observer.ts): a tool
    // that crossed the refuse threshold — especially one hit from inside a
    // code_exec script, where the nested pre-check refuses before dispatch —
    // otherwise stays blocked for the whole run because it can never run to
    // succeed and self-clear. The forced re-plan is exactly the moment to give
    // it a clean slate.
    resetFailureStreaks(ctx.failureStreaks);
    ctx.noProgressTracker.clear();
    ctx.opts.toolContext.toolCallLedger?.resetNoProgress();

    if (loopEvent) {
      ctx.transition = guardToTransition(loopEvent.guard);
      const nudgeKey = `${loopEvent.guard}:${loopEvent.toolName ?? '*'}`;
      const lastNudgeTurn = ctx.lastStrategyNudgeTurnByKey.get(nudgeKey);
      if (lastNudgeTurn == null || ctx.turn - lastNudgeTurn >= 5) {
        ctx.lastStrategyNudgeTurnByKey.set(nudgeKey, ctx.turn);
        ctx.messages.push({
          role: 'user',
          content: [{
            type: 'text',
            text: buildLoopGuardReflectionMarker({
              guard: loopEvent.guard,
              toolName: loopEvent.toolName,
              count: loopEvent.count,
            }),
          }],
        });
      }
    }

    return events.turnSucceeded({ hasToolCalls: false });
  }
}

function guardToTransition(
  guard: 'tuple-hash' | 'doom-loop' | 'dominance' | 'failure-streak',
): TransitionKind {
  switch (guard) {
    case 'tuple-hash':
      return 'dup-call-cap';
    case 'doom-loop':
      return 'doom-loop-strict';
    case 'dominance':
      return 'doom-loop-fuzzy';
    case 'failure-streak':
      return 'failure-streak';
  }
}
