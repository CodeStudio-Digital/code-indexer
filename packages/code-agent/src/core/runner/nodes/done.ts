/**
 * Done node — terminal sentinel. The orchestrator's main `while` loop
 * exits when `state === 'Done'`, so this node's `execute` is unreachable.
 * It exists only to satisfy the `Record<NodeState, BehaviorNode>` shape;
 * throwing makes any accidental invocation loud.
 *
 * The node that *transitions* to Done is responsible for populating
 * `ctx.stopReason` (and `ctx.transition` / `ctx.error` where applicable)
 * before emitting `CleanFinish` / `Aborted`.
 */
import type { BehaviorEvent, BehaviorNode, RunContext } from '../machine/types.js';

export class DoneNode implements BehaviorNode {
  readonly state = 'Done' as const;

  async execute(_ctx: RunContext, _lastEvent: BehaviorEvent | null): Promise<BehaviorEvent> {
    throw new Error('DoneNode.execute is unreachable — Done is terminal.');
  }
}
