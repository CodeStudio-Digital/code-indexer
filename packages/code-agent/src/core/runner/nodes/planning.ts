/**
 * Planning node — entered after a loop guard (tuple-hash dedup, doom-loop,
 * dominance, failure-streak) emits `ToolLoopDetected`. Behavior:
 *
 *   1. Push a one-shot reflection `<system-reminder>` naming WHICH guard
 *      fired (tool + count when the event carries them) and directing a
 *      strategy change before the next tool batch. Without this the model
 *      re-entered Executing with zero steering and usually replayed the
 *      same call (the cross-cycle enforcement marker only fires after ~2
 *      full refusal cycles — this covers the FIRST one).
 *   2. Reset the dedup table so legit re-verify workflows (re-running
 *      `npm test` after a fix) aren't permanently blocked — but RETAIN the
 *      signatures that were already refusing (count ≥ `DUP_REFUSE_MIN`) for
 *      exactly one turn, so the immediate next turn can't replay the exact
 *      call that tripped the guard. Executing expires the retention.
 *   3. Record the trigger reason in `ctx.transition` for `RunResult`
 *      attribution.
 */
import type { BehaviorEvent, BehaviorNode, RunContext } from '../machine/types.js';
import type { TransitionKind } from '../types.js';
import { events } from '../machine/events.js';
import { resetDupCalls, DUP_REFUSE_MIN } from '../guards/tuple-hash-dedup.js';
import { buildLoopGuardReflectionMarker } from '../markers.js';

export class PlanningNode implements BehaviorNode {
  readonly state = 'Planning' as const;

  async execute(ctx: RunContext, lastEvent: BehaviorEvent | null): Promise<BehaviorEvent> {
    const loopEvent = lastEvent?.kind === 'ToolLoopDetected' ? lastEvent : null;

    // Clean slate with 1-turn retention of the offending signatures. Only
    // the tuple-hash guard keys off `dupCalls`; the other guards' state is
    // reset inside `evaluatePerTurnLoops` when they fire.
    const retained = loopEvent?.guard === 'tuple-hash'
      ? [...ctx.dupCalls].filter(([, entry]) => entry.count >= DUP_REFUSE_MIN)
      : [];
    resetDupCalls(ctx.dupCalls);
    if (retained.length > 0) {
      for (const [key, entry] of retained) ctx.dupCalls.set(key, entry);
      ctx.retainedLoopKeys = {
        keys: retained.map(([key]) => key),
        expiresAfterTurn: ctx.turn + 1,
      };
    }

    if (loopEvent) {
      ctx.transition = guardToTransition(loopEvent.guard);
      // One-shot by construction: Planning executes once per ToolLoopDetected.
      // Deterministic marker → prefix-cache safe (message stream content).
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
