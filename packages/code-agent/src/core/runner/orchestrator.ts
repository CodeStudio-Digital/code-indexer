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
   * Passed BY REFERENCE — the host's `promoteTier` mutates it mid-run.
   */
  initialTiers: Set<ToolTier> | null;
  /**
   * Pinned tools (hidden tools the model called by name). Passed BY
   * REFERENCE from the host runner; dispatch adds names mid-run and the
   * next turn's `buildTools` unions them in.
   */
  initialPins?: Set<string>;
  /**
   * Live message array shared with the host (`CoderRunner.this.messages`).
   * Passed BY REFERENCE so external mutators (`pushUserContent`,
   * `appendSystemReminder`) stay in sync with what the BT pushes.
   */
  initialMessages?: import('@mcp/code-agent/core/messages.js').AgentMessage[];
  /** Optional bridge to legacy CoderRunner state (skills, gates, etc.). */
  bridge?: BridgeCallbacks;
}

// `isBehaviorTreeEnabled` was the flag-driven router during the BT
// migration. After the post-Frente-E sweep, the legacy while-loop is
// gone and the BT is the only path — nothing reads this anymore and the
// `CODER_LEGACY_RUNNER` env var is a no-op (documented for the
// historical record only).

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
    initialPins: args.initialPins,
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

  // A5 — set of allowed BehaviorEvent.kind values. Anything outside this
  // set means a node returned garbage and we should force-abort the run
  // (silently falling through to 'Done' was masking real bugs upstream).
  const VALID_EVENT_KINDS: ReadonlySet<string> = new Set([
    'TurnSucceeded', 'TokenThresholdHit', 'ToolLoopDetected',
    'MaxTurnsReached', 'ProviderError', 'CompactionDone',
    'CleanFinish', 'Aborted',
  ]);

  let state: NodeState = 'Bootstrap';
  let lastEvent: BehaviorEvent | null = null;
  // Frente E — dwell telemetry. Record entry time per node visit; emit
  // a `bt_state_dwell` event with the wall-clock dwell once the
  // transition is decided. Aggregate per-node totals too so the final
  // log line has the full profile.
  let stateEnteredAt = Date.now();
  const dwellTotals: Partial<Record<NodeState, number>> = {};
  try {
    while (state !== 'Done') {
      const node = nodes[state];
      console.log(`[coder/bt] node=${state} turn=${ctx.turn}`);
      let event: BehaviorEvent;
      try {
        event = await node.execute(ctx, lastEvent);
      } catch (e) {
        // A node throwing used to re-throw out of `runBehaviorTree`, which
        // skipped the terminal `ctx.emit('done')` below (it lives after the
        // try/finally) — leaving SSE/dashboard listeners stuck in
        // "streaming…" forever. Convert the throw into an `Aborted` event
        // (same shape as the A5 invalid-event branch) so the loop exits
        // cleanly to `Done`, the `finally` runs cleanup, and `done` fires
        // with `reason='error'` + the captured error. Contract: the BT
        // never throws — it always emits `done` and returns a `RunResult`.
        console.error(`[coder/bt] node=${state} threw:`, e);
        ctx.stopReason = ctx.stopReason ?? 'error';
        ctx.error = ctx.error ?? (e instanceof Error ? e : new Error(String(e)));
        event = { kind: 'Aborted' };
      }
      // A5 — validate the returned event. Garbage (undefined, null,
      // missing kind, unknown kind) is treated as a node bug and routed
      // to Aborted with a clear stopReason. Without this the fall-through
      // (nextState → 'Done' default) terminated the run with reason=null.
      if (!event || typeof event !== 'object' || !VALID_EVENT_KINDS.has(event.kind)) {
        const got = event === null ? 'null'
          : event === undefined ? 'undefined'
          : typeof event !== 'object' ? typeof event
          : `kind=${String((event as { kind?: unknown }).kind)}`;
        console.error(`[coder/bt] node=${state} returned INVALID event (${got}). Forcing Aborted.`);
        ctx.stopReason = ctx.stopReason ?? 'error';
        ctx.error = ctx.error ?? new Error(`BT node ${state} returned invalid event: ${got}`);
        event = { kind: 'Aborted' };
      }
      // Frente E — dwell telemetry. Compute the leave-time first so the
      // emit reflects the actual time spent (excluding any synthetic
      // event upgrade in the validation branch above).
      const dwellMs = Date.now() - stateEnteredAt;
      dwellTotals[state] = (dwellTotals[state] ?? 0) + dwellMs;
      try {
        ctx.emit('bt_state_dwell', {
          runId: ctx.runId,
          state,
          event: event.kind,
          dwellMs,
          turn: ctx.turn,
        });
      } catch (e) {
        // Never let telemetry break the run. SSE handlers can throw on
        // backpressure; the BT should keep going.
        console.warn(
          `[coder/bt] bt_state_dwell emit failed (${state}→${event.kind}): ` +
          (e instanceof Error ? e.message : String(e)),
        );
      }
      console.log(`[coder/bt] node=${state} → event=${event.kind} dwellMs=${dwellMs}`);
      lastEvent = event;
      state = nextState(state, event);
      stateEnteredAt = Date.now();

      // Liveness — a CLEAN finish must not end the run while background
      // subagents are still working. Park until a job settles (the bridge
      // injects a completion notice → we resume Executing to react), the user
      // sends a message, the run aborts, or a safety cap elapses. Gated on
      // `hasActive()`, so sessions/subagents without background jobs (the vast
      // majority) see zero behavior change. Aborts/errors are NOT parked.
      if (state === 'Done' && event.kind === 'CleanFinish' && ctx.bridge?.backgroundJobs?.hasActive()) {
        const signal = ctx.opts.toolContext.signal ?? new AbortController().signal;
        console.log(`[coder/bt] clean finish with active background jobs — parking runId=${ctx.runId}`);
        const outcome = await ctx.bridge.backgroundJobs.park(signal);
        console.log(`[coder/bt] park woke: ${outcome}`);
        if (outcome === 'work' || outcome === 'message') {
          state = 'Executing';
          stateEnteredAt = Date.now();
        }
        // 'aborted' / 'timeout' → fall through to Done.
      }
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
      // PR-B: any execute_tasks runs that were `running` when the worker
      // exited (crash, OOM, intentional shutdown) get promoted to
      // `aborted` with reject_reason='worker_restart'. The dashboard
      // resumes correctly; the agent's next turn sees consistent state.
      try {
        store.recoverRunningTaskRuns(sessionId);
      } catch (e) {
        console.warn(
          `[coder/bt] recoverRunningTaskRuns on shutdown failed: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
    ctx.operations.abortAll('run shutdown');
  }

  const reason = ctx.stopReason ?? 'completed';
  const transition = ctx.transition;
  // Frente E — surface the BT profile in the run-final log so an
  // operator can spot pathological dwells (Compacting>30s, Executing
  // dwarfing everything, Recovering looping) without enabling SSE.
  const profile = (Object.keys(dwellTotals) as NodeState[])
    .map((s) => `${s}=${dwellTotals[s]}ms`)
    .join(' ');
  console.log(`[coder/bt] done runId=${ctx.runId} reason=${reason} profile={${profile}}`);

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
