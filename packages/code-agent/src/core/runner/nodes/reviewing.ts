/**
 * Reviewing node — post-compaction/max-turn sanity pass. Validates the
 * invariants the compactor is supposed to maintain and either routes back to
 * Executing after compaction or terminates a run whose hard turn ceiling was
 * reached.
 *
 * Invariants checked:
 *   1. `'bootstrap'` is still in `activeTiers`. The compactor doesn't touch
 *      tiers, but this is the canonical place to re-assert the invariant.
 *   2. At least one message remains. Empty history is impossible in
 *      practice but we treat it as a clean finish rather than spinning.
 *
 * Pair integrity (no orphan tool_results in the tail) is enforced by
 * `snapCutoffPreservingPairs` inside the compactor, so it does NOT need to
 * be re-checked here.
 */
import type { BehaviorEvent, BehaviorNode, RunContext } from '../machine/types.js';
import { events } from '../machine/events.js';

export class ReviewingNode implements BehaviorNode {
  readonly state = 'Reviewing' as const;

  async execute(ctx: RunContext, lastEvent: BehaviorEvent | null): Promise<BehaviorEvent> {
    if (ctx.activeTiers !== null && !ctx.activeTiers.has('bootstrap')) {
      ctx.activeTiers.add('bootstrap');
    }

    if (ctx.messages.length === 0) {
      ctx.stopReason = 'completed';
      return events.cleanFinish();
    }

    // MaxTurnsReached is a terminal budget verdict. Returning
    // TurnSucceeded here used to re-enter Executing at the same exhausted
    // counter, allowing an unbounded Reviewing → Executing loop whenever the
    // model kept emitting tools. Keep the Reviewing hop for invariant repair
    // and telemetry, but never grant an implicit extra provider turn.
    if (lastEvent?.kind === 'MaxTurnsReached') {
      ctx.stopReason = 'max_turns';
      return events.cleanFinish();
    }

    return events.turnSucceeded({ hasToolCalls: false });
  }
}
