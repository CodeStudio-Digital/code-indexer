/**
 * RunContext factory and small mutators. The context is the single piece of
 * mutable state shared across every node — replacing dozens of private
 * fields on the legacy `CodeAgentRunner` class.
 *
 * Invariants enforced here:
 *   1. `activeTiers` always contains `'bootstrap'`.
 *   2. `totalUsage` starts at the canonical zero shape.
 *   3. `runId` is a fresh uuid per run (telemetry correlation).
 */
import { randomUUID } from 'node:crypto';
import type { AgentMessage, ChatUsage } from '@mcp/code-agent/core/messages.js';
import type { ToolTier } from '@mcp/code-agent/tools/tiers.js';
import type { RunnerOptions } from '../types.js';
import type { RecoveryKind } from '../recovery-config.js';
import type { BridgeCallbacks, RunContext } from './types.js';
import { AsyncOperationRegistry } from '../operations.js';
import { emptyFailureStreakState } from '../guards/failure-streak.js';
import { createDoomLoopState } from '../guards/doom-loop.js';
import { createDominanceState } from '../guards/dominance.js';

export interface CreateRunContextArgs {
  opts: RunnerOptions;
  emit: RunContext['emit'];
  /**
   * Initial tier filter — null disables filtering (the BT sees every tool
   * the registry has). Otherwise `ensureBootstrap` adds `'bootstrap'`
   * before storing on the context.
   *
   * Passed BY REFERENCE (same contract as `initialMessages`): the host's
   * `CoderRunner.promoteTier` (the `expand_toolset` handler) mutates this
   * Set mid-run, and `buildTools` must observe the promotion on the next
   * turn. Copying here silently froze every mid-run promotion.
   */
  initialTiers: Set<ToolTier> | null;
  /**
   * Pinned tools — registered tools the model called while they were
   * hidden (tier-hidden or cap-cut). Shared BY REFERENCE with the host
   * runner so dispatch-time pins are visible to the next `buildTools`.
   * Monotone: names are only ever added.
   */
  initialPins?: Set<string>;
  /**
   * Live messages reference shared with the host (e.g. `CoderRunner.this.messages`).
   * Passed BY REFERENCE — the BT pushes assistant/tool blocks onto this array
   * so external mutators (e.g. `runner.pushUserContent`, `appendSystemReminder`)
   * stay in sync.
   *
   * When omitted, falls back to copying `opts.initialMessages` (subagent /
   * fresh-construction paths where there is no host array to share).
   */
  initialMessages?: AgentMessage[];
  /** Optional callbacks bridging BT to features still owned by CoderRunner. */
  bridge?: BridgeCallbacks;
}

export function createRunContext(args: CreateRunContextArgs): RunContext {
  // Prefer the shared reference (`args.initialMessages`) when provided so
  // the BT and host observe the same array. Fall back to copying
  // `opts.initialMessages` when no shared reference exists.
  const messages: AgentMessage[] =
    args.initialMessages ??
    (args.opts.initialMessages ? [...args.opts.initialMessages] : []);
  return {
    opts: args.opts,
    emit: args.emit,
    messages,
    turn: 0,
    totalUsage: zeroUsage(),
    activeTiers: ensureBootstrap(args.initialTiers),
    pinnedTools: args.initialPins ?? new Set<string>(),
    recovery: new Map(),
    dupCalls: new Map(),
    loopRefusals: new Map(),
    autoContinues: 0,
    preEmitCompactions: 0,
    consecutiveNoopCompactions: 0,
    planNudges: 0,
    goalVerifyAttempts: 0,
    estimateCalibration: null,
    runId: randomUUID(),
    aborted: false,
    transition: null,
    stopReason: null,
    error: null,
    operations: new AsyncOperationRegistry(args.emit),
    bridge: args.bridge,
    // Telemetry — set by ExecutingNode after each successful turn.
    // Host's `flushPendingTurn` (`index.ts`) reads from
    // `runner.lastTurnTelemetryId`, which mirrors this value through
    // the bridge callback in `runViaBehaviorTree`.
    lastTurnTelemetryId: null,
    // PR 5 — per-tool failure-streak counters start empty. Mutated by
    // `executing-dispatch.ts` after every tool result; cleared per tool
    // on the first `isError=false`.
    failureStreaks: emptyFailureStreakState(),
    // P0 — per-turn doom-loop + dominance rolling windows. Mutated by
    // ExecutingNode after each turn's dispatch; reset only when a guard fires.
    doomLoop: createDoomLoopState(),
    dominance: createDominanceState(),
    // Fix B — loop-aware compaction signals start at zero; ExecutingNode
    // advances them each turn, CompactingNode checkpoints/resets on collapse.
    consecutiveNoTextTurns: 0,
    cumulativeInputTokens: 0,
    cumulativeAtLastCompaction: 0,
    // PR-F — dynamic-injection state starts empty; Executing/Compacting
    // mutate it as they emit reminders / compact.
    injectionState: {
      lastInjectedSkillIds: new Set<string>(),
      executedSkillIds: new Set<string>(),
      lastInjectedFiles: new Set<string>(),
      recentCompactionAt: null,
      lastInjectedMemoryIds: new Set<string>(),
      lastInjectedSessionStateHash: null,
      lastInjectedProjectIndexHash: null,
      lastInjectedUserMemoryHash: null,
      lastInjectedPreflightHash: null,
      // Fix A — self_review nudge gate state (empty = nudge allowed once
      // there are unreviewed pending changes).
      selfReview: { suppressed: false },
    },
  };
}

function zeroUsage(): ChatUsage {
  return {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  };
}

/**
 * Bootstrap tier is non-negotiable. When tiers are non-null, the bootstrap
 * tier is added before returning; when tiers are null the caller has
 * disabled filtering entirely (subagents/tests) and bootstrap survives
 * trivially since every tool is exposed.
 *
 * Mutates and returns the GIVEN Set — the context must alias the host
 * runner's `activeTiers` so `promoteTier()` (expand_toolset) reaches the
 * next turn's `buildTools`. The historical copy here silently disconnected
 * every mid-run tier promotion from the BT.
 */
export function ensureBootstrap(tiers: Set<ToolTier> | null): Set<ToolTier> | null {
  if (tiers === null) return null;
  tiers.add('bootstrap');
  return tiers;
}

/** Increment and return the recovery counter for a given kind. */
export function bumpRecovery(ctx: RunContext, kind: RecoveryKind): number {
  const next = (ctx.recovery.get(kind) ?? 0) + 1;
  ctx.recovery.set(kind, next);
  return next;
}

/** Append-only usage accumulator. Mirrors `runner.ts` totalUsage handling. */
export function accumulateUsage(ctx: RunContext, usage: ChatUsage | null): void {
  if (!usage) return;
  ctx.totalUsage.input_tokens += usage.input_tokens ?? 0;
  ctx.totalUsage.output_tokens += usage.output_tokens ?? 0;
  ctx.totalUsage.cache_creation_input_tokens =
    (ctx.totalUsage.cache_creation_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
  ctx.totalUsage.cache_read_input_tokens =
    (ctx.totalUsage.cache_read_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);
}
