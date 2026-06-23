/**
 * Planning node — entered after the tuple-hash guard or the doom-loop
 * backstop emits `ToolLoopDetected`. Behavior:
 *
 *   1. Reset the dedup table — the agent gets a clean slate so the prior
 *      "refuse" verdict doesn't immediately fire again on the next turn.
 *   2. Record the trigger reason in `ctx.transition` for `RunResult`
 *      attribution.
 *
 * In Commit 6 (Executing real) this node will also append a system-
 * reminder onto the trailing user message asking the model to reflect
 * before the next tool batch. For now the dedup reset alone is enough to
 * break the loop in the next turn.
 */
import type { BehaviorEvent, BehaviorNode, RunContext } from '../machine/types.js';
import type { TransitionKind } from '../types.js';
import { events } from '../machine/events.js';
import { resetDupCalls } from '../guards/tuple-hash-dedup.js';

export class PlanningNode implements BehaviorNode {
  readonly state = 'Planning' as const;

  async execute(ctx: RunContext, lastEvent: BehaviorEvent | null): Promise<BehaviorEvent> {
    resetDupCalls(ctx.dupCalls);

    if (lastEvent?.kind === 'ToolLoopDetected') {
      ctx.transition = guardToTransition(lastEvent.guard);
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
