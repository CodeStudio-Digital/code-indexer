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
import type {
  BehaviorEvent,
  BehaviorNode,
  BridgeCallbacks,
  NodeState,
  RunContext,
} from './machine/types.js';
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
  /**
   * Tier filter for `buildTools`. Pass null to disable filtering (the
   * agent sees every registered tool — used by subagents and tests where
   * the parent has already pre-filtered the registry).
   */
  initialTiers: Set<ToolTier> | null;
  /**
   * Live message array shared with the host (`CoderRunner.this.messages`).
   * Passed BY REFERENCE so external mutators (`pushUserContent`,
   * `appendSystemReminder`) stay in sync with what the BT pushes.
   */
  initialMessages?: import('@mcp/code-agent/core/messages.js').AgentMessage[];
  /** Optional bridge to legacy CoderRunner state (skills, gates, etc.). */
  bridge?: BridgeCallbacks;
}

/**
 * Routing predicate consumed by `runner.ts`. **Default-on** since Commit 7:
 *   - returns true unless `CODER_LEGACY_RUNNER=1` (explicit opt-out).
 *
 * The legacy while-loop in `runner.ts` is kept as a safety net for cases
 * the BT's Executing node doesn't cover yet (plan/spec mode gating, deep-
 * think, polling caps, quality watchdog, pre-read enforcement). If the
 * BT throws, `runner.ts` catches and falls through to the legacy path
 * automatically — `CODER_LEGACY_RUNNER=1` is for forcing the bypass.
 */
export function isBehaviorTreeEnabled(): boolean {
  return process.env.CODER_LEGACY_RUNNER !== '1';
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
    initialMessages: args.initialMessages,
    bridge: args.bridge,
  });
  console.log(`[coder/bt] starting runId=${ctx.runId} provider=${ctx.opts.provider.name} model=${ctx.opts.provider.model}`);

  // Yield one microtask + one macrotask before the first node executes.
  // The host (coder-worker / SSE route) calls `wireRunnerEventsToBus`
  // SYNCHRONOUSLY after `await runCoder(...)` resolves; without this
  // breath the `run_started` event Bootstrap emits would land before
  // those listeners exist and disappear into the void.
  await new Promise<void>((resolve) => setImmediate(resolve));

  let state: NodeState = 'Bootstrap';
  let lastEvent: BehaviorEvent | null = null;
  try {
    while (state !== 'Done') {
      const node = nodes[state];
      console.log(`[coder/bt] node=${state} turn=${ctx.turn}`);
      let event: BehaviorEvent;
      try {
        event = await node.execute(ctx, lastEvent);
      } catch (e) {
        console.error(`[coder/bt] node=${state} threw:`, e);
        throw e;
      }
      console.log(`[coder/bt] node=${state} → event=${event.kind}`);
      lastEvent = event;
      state = nextState(state, event);
    }
  } finally {
    // Lifecycle cleanup — tasks left in `running` (because the BT exited
    // mid-execute_task, was aborted, hit a circuit breaker, or a node
    // threw) get promoted to `interrupted` so the dashboard doesn't show
    // false spinners and the next resume sees real state. Best-effort:
    // a DB failure here MUST NOT mask the RunResult.
    const store = ctx.opts.sessionStore;
    const sessionId = ctx.opts.sessionId;
    if (store && sessionId != null) {
      try {
        store.recoverStaleTasks(sessionId);
      } catch (e) {
        console.warn(
          `[coder/bt] recoverStaleTasks on shutdown failed: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
  }

  const reason = ctx.stopReason ?? 'completed';
  const transition = ctx.transition;
  console.log(`[coder/bt] done runId=${ctx.runId} reason=${reason}`);

  // Mirror the legacy `finishWith()` — emit the terminal `done` event so
  // listeners (SSE, CLI, dashboard) can dismiss their "streaming…" state.
  // Without this the UI sees text deltas but never the lifecycle close.
  ctx.emit('done', reason, ctx.error ?? undefined, transition);

  return {
    totalUsage: ctx.totalUsage,
    reason,
    transition,
  };
}
