/**
 * Bootstrap node — turn 0 setup. Emits `run_started` so dashboards can
 * correlate the rest of the lifecycle events with a stable runId, then
 * yields to the Executing node.
 *
 * Tier resolution happened in `createRunContext` (`ensureBootstrap`) — by
 * the time this node runs, `ctx.activeTiers` is already populated. The
 * Bootstrap node only handles the lifecycle event so future work (e.g.
 * pre-flight checks, plan-mode gate validation) has a single, named
 * insertion point.
 */
import type { BehaviorEvent, BehaviorNode, RunContext } from '../machine/types.js';
import { events } from '../machine/events.js';

export class BootstrapNode implements BehaviorNode {
  readonly state = 'Bootstrap' as const;

  async execute(ctx: RunContext, _lastEvent: BehaviorEvent | null): Promise<BehaviorEvent> {
    console.log(`[coder/bt] Bootstrap emitting run_started runId=${ctx.runId}`);
    ctx.emit('run_started', {
      runId: ctx.runId,
      provider: ctx.opts.provider.name,
      model: ctx.opts.provider.model,
      profile: ctx.opts.profile ?? null,
      planMode: !!ctx.opts.planMode,
      maxTurns: ctx.opts.maxTurns ?? 50,
      ...(ctx.opts.executionUltra ? { ultra: ctx.opts.executionUltra } : {}),
    });

    // Invariant defence: when tier filtering is active the BT never enters
    // Executing without `bootstrap` available. `createRunContext` enforces
    // this via `ensureBootstrap`, but a future code path could mutate
    // `activeTiers` — keep the check loud rather than silent. When
    // `activeTiers === null` filtering is disabled entirely (subagents).
    if (ctx.activeTiers !== null && !ctx.activeTiers.has('bootstrap')) {
      ctx.activeTiers.add('bootstrap');
    }

    return events.turnSucceeded({ hasToolCalls: false });
  }
}
