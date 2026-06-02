/**
 * AgentSupervisor — Runner event observer (Sprint 4 Phase 2.1).
 *
 * Subscribes to a `CoderRunner`'s EventEmitter signals and translates
 * them into supervisor transitions + heartbeats. WITHOUT this wiring,
 * the supervisor's stuck detection relies on coarse bus signals
 * (master.ended, subordinate completion) and may flag healthy agents
 * as stuck simply because no fine-grained heartbeat reached the
 * tracker.
 *
 * **Coverage map** — translation table from runner events to
 * supervisor operations:
 *
 *   | runner event           | supervisor op                                   |
 *   |------------------------|-------------------------------------------------|
 *   | run_started            | (no-op — record exists in BOOTING from spawn)   |
 *   | turn_start             | transition → RUNNING_TURN                       |
 *   | provider_call          | transition → AWAITING_PROVIDER                  |
 *   | text_delta             | heartbeat (provider responding)                 |
 *   | thinking_delta         | heartbeat                                       |
 *   | message_complete       | transition → RUNNING_TURN (back from provider)  |
 *   | tool_call_start        | transition → AWAITING_TOOL (capture id+name)    |
 *   | tool_progress          | heartbeat (tool still alive)                    |
 *   | tool_call_result       | transition → RUNNING_TURN                       |
 *   | tool_call_finalized    | heartbeat                                       |
 *   | done                   | transition → TERMINAL                           |
 *
 * **Why not use HookRegistry directly**: HookRegistry has 4 hook kinds
 * (toolCall/error/fallback/completion) — narrower than the ~40 events.
 * For Phase 2.1 we need granular event subscription that only
 * EventEmitter offers. Phase 3 can collapse to HookRegistry if event
 * surface grows redundant.
 *
 * **Lifetime**: caller invokes `wireSupervisorToRunner(runner, agentRunId)`
 * inside `onRunnerReady`. Returns an `unsubscribe` function that
 * `attachSubordinateCompletionHandler` calls in its `.finally` so the
 * listeners don't leak after runner exit.
 */
import type { CoderRunner } from '@mcp/code-agent/core/runner.js';
import { getGlobalAgentSupervisor } from './global.js';
import { getGlobalToolBaseline } from './tool-duration-baseline.js';

/**
 * Subscribe a runner's events to the global supervisor. Idempotent
 * per `(runner, agentRunId)` pair — calling twice double-subscribes,
 * so callers MUST keep the unsubscribe handle. No-op when no
 * supervisor is configured (env flag off).
 */
export function wireSupervisorToRunner(
  runner: CoderRunner,
  agentRunId: number,
): () => void {
  const supervisor = getGlobalAgentSupervisor();
  if (!supervisor) return () => { /* no-op */ };

  // Each subscription returns a cleanup callback so we can unwire
  // them all in one shot when the runner exits. The cast is required
  // because EventEmitter's typed signature (`RunnerEvents`) enforces
  // event-specific callback shapes — our supervisor handlers are
  // intentionally loose (`(...args) => void`) because we only care
  // about the first 1-2 positional args (toolUseId, toolName).
  const cleanups: Array<() => void> = [];
  type AnyEmitter = {
    on: (event: string, listener: (...args: unknown[]) => void) => unknown;
    off: (event: string, listener: (...args: unknown[]) => void) => unknown;
  };
  const emitter = runner as unknown as AnyEmitter;
  const on = (event: string, listener: (...args: unknown[]) => void): void => {
    emitter.on(event, listener);
    cleanups.push(() => {
      try { emitter.off(event, listener); } catch { /* best-effort */ }
    });
  };

  on('turn_start', () => {
    supervisor.transition(agentRunId, 'RUNNING_TURN');
  });

  on('provider_call', () => {
    supervisor.transition(agentRunId, 'AWAITING_PROVIDER');
  });

  // text_delta / thinking_delta fire frequently during a streaming
  // response — they're the strongest heartbeat (provider is alive +
  // emitting). We DON'T transition state because the runner is still
  // logically inside AWAITING_PROVIDER (or RUNNING_TURN after stream).
  on('text_delta', () => { supervisor.heartbeat(agentRunId); });
  on('thinking_delta', () => { supervisor.heartbeat(agentRunId); });

  on('message_complete', () => {
    // Provider finished streaming. We're back in RUNNING_TURN
    // (potentially about to dispatch tools or end).
    supervisor.transition(agentRunId, 'RUNNING_TURN');
  });

  // Phase 3.4 — track tool-call timing for the per-tool baseline.
  // Map keyed by toolUseId so concurrent tool calls in one runner
  // don't trample each other.
  const toolStartTimes = new Map<string, { startMs: number; toolName: string }>();
  const baseline = getGlobalToolBaseline();

  on('tool_call_start', (...args: unknown[]) => {
    // Signature: emit('tool_call_start', toolUseId, toolName, toolInput)
    const toolUseId = typeof args[0] === 'string' ? args[0] : null;
    const toolName = typeof args[1] === 'string' ? args[1] : null;
    supervisor.transition(agentRunId, 'AWAITING_TOOL', { toolUseId, toolName });

    if (toolUseId && toolName) {
      toolStartTimes.set(toolUseId, { startMs: Date.now(), toolName });
      // Adaptive timeout: if we have enough samples for this tool,
      // use baseline.p90 × factor instead of the default 5min. Detects
      // hangs earlier than the static fallback.
      const overrideMs = baseline.outlierThresholdMs(toolName);
      if (overrideMs != null) {
        supervisor.setStateTimeoutOverride(agentRunId, overrideMs);
      }
    }
  });

  on('tool_progress', () => { supervisor.heartbeat(agentRunId); });

  // Insistent-loop enforcement — the runner injected a break-the-loop
  // reminder after refusing the same tool+args across planning cycles.
  // Record it (dashboard incident + abort backstop). Other intervention
  // kinds (dup-call-cap, failure-streak, …) are handled by their own guards.
  on('tool_loop_intervention', (...args: unknown[]) => {
    const payload = args[0] as { kind?: string; toolName?: string } | undefined;
    if (payload?.kind === 'loop-enforced') {
      supervisor.recordLoopEnforced(agentRunId, payload.toolName ?? 'unknown');
    }
  });

  on('tool_call_result', (...args: unknown[]) => {
    // Signature: emit('tool_call_result', toolUseId, result, ...)
    const toolUseId = typeof args[0] === 'string' ? args[0] : null;
    // Record duration for the baseline. Any result (even errors) means
    // the tool returned — that's a valid sample for "didn't hang".
    if (toolUseId) {
      const start = toolStartTimes.get(toolUseId);
      if (start) {
        const duration = Date.now() - start.startMs;
        baseline.recordSuccess(start.toolName, duration);
        toolStartTimes.delete(toolUseId);
      }
    }
    // Clear the timeout override now that we're back in RUNNING_TURN
    // (no tool active → use default RUNNING_TURN timeout).
    supervisor.setStateTimeoutOverride(agentRunId, null);
    // Back to RUNNING_TURN — runner continues processing or starts
    // another tool batch.
    supervisor.transition(agentRunId, 'RUNNING_TURN');
  });

  on('tool_call_finalized', () => { supervisor.heartbeat(agentRunId); });

  on('done', () => {
    // Terminal — actual reason (success/failure) is handled separately
    // by `subordinateCompletionBus.emit` inside completion-handler.
    // We mark TERMINAL here too so even subagent runs (which don't go
    // through the completion bus) stop being tracked.
    supervisor.transition(agentRunId, 'TERMINAL');
  });

  return () => {
    for (const c of cleanups) c();
  };
}
