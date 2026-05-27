/**
 * Behavior Tree orchestrator — the single entry point for the new runner.
 *
 * Drives `state = nextState(state, await node.execute(ctx))` until `Done`,
 * then returns a `RunResult` populated from `ctx.stopReason / transition /
 * totalUsage`.
 *
 * Wiring stage (Commit 1):
 *   - Lives behind `CODER_BT_ENABLED=1`. Default-off keeps the legacy
 *     `while (turn<maxTurns)` loop in runner.ts authoritative.
 *   - Every node is a stub; activating the flag throws loudly on the very
 *     first state transition. That's intentional — Commit 1 only proves the
 *     scaffolding compiles and the transition table is sound.
 *
 * Subsequent commits replace stubs progressively:
 *   - Commit 3 → Bootstrap, Executing, Recovering, Done bodies.
 *   - Commit 4 → Compacting, Reviewing bodies + LLM compactor.
 *   - Commit 5 → Planning body + tuple-hash guard.
 *   - Commit 6 → kill legacy fallbacks, flag becomes default-on.
 *   - Commit 7 → flag removed, runner.ts shrinks to facade.
 */
import type { ToolTier } from '@mcp/code-agent/tools/tiers.js';
import type { RunnerOptions, RunResult } from './types.js';
import type { BehaviorEvent, BehaviorNode, NodeState, RunContext } from './machine/types.js';
import { createRunContext } from './machine/context.js';
import { nextState } from './machine/transitions.js';
import { BootstrapNode } from './nodes/bootstrap.js';
import { PlanningNode } from './nodes/planning.js';
import { ExecutingNode } from './nodes/executing.js';
import { CompactingNode } from './nodes/compacting.js';
import { ReviewingNode } from './nodes/reviewing.js';
import { RecoveringNode } from './nodes/recovering.js';
import { DoneNode } from './nodes/done.js';

export interface OrchestratorArgs {
  opts: RunnerOptions;
  emit: RunContext['emit'];
  initialTiers: Set<ToolTier>;
}

/**
 * Routing predicate consumed by `runner.ts`. When this returns true the
 * caller delegates to `runBehaviorTree`; otherwise the legacy loop runs.
 */
export function isBehaviorTreeEnabled(): boolean {
  return process.env.CODER_BT_ENABLED === '1';
}

/**
 * Build the node table for this run. Exposed (not inlined) so tests can
 * substitute mock nodes for individual states without monkey-patching
 * module exports.
 */
export function buildDefaultNodes(): Record<NodeState, BehaviorNode> {
  return {
    Bootstrap: new BootstrapNode(),
    Planning: new PlanningNode(),
    Executing: new ExecutingNode(),
    Compacting: new CompactingNode(),
    Reviewing: new ReviewingNode(),
    Recovering: new RecoveringNode(),
    Done: new DoneNode(),
  };
}

/**
 * Drive the BT until termination. Each iteration runs the current state's
 * node, then maps the emitted event to the next state. The node that
 * transitions to `Done` is responsible for populating `ctx.stopReason`
 * (and `ctx.transition` / `ctx.error` if relevant) BEFORE emitting
 * `CleanFinish` / `Aborted`.
 */
export async function runBehaviorTree(
  args: OrchestratorArgs,
  nodes: Record<NodeState, BehaviorNode> = buildDefaultNodes(),
): Promise<RunResult> {
  const ctx = createRunContext({
    opts: args.opts,
    emit: args.emit,
    initialTiers: args.initialTiers,
  });

  let state: NodeState = 'Bootstrap';
  let lastEvent: BehaviorEvent | null = null;
  while (state !== 'Done') {
    const node = nodes[state];
    const event = await node.execute(ctx, lastEvent);
    lastEvent = event;
    state = nextState(state, event);
  }

  return {
    totalUsage: ctx.totalUsage,
    reason: ctx.stopReason ?? 'completed',
    transition: ctx.transition,
  };
}
