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

export interface CreateRunContextArgs {
  opts: RunnerOptions;
  emit: RunContext['emit'];
  /**
   * Initial tier filter — null disables filtering (the BT sees every tool
   * the registry has). Otherwise `ensureBootstrap` adds `'bootstrap'`
   * before storing on the context.
   */
  initialTiers: Set<ToolTier> | null;
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
    recovery: new Map(),
    dupCalls: new Map(),
    autoContinues: 0,
    preEmitCompactions: 0,
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
    // PR-F — dynamic-injection state starts empty; Executing/Compacting
    // mutate it as they emit reminders / compact.
    injectionState: {
      lastInjectedSkillIds: new Set<string>(),
      lastInjectedFiles: new Set<string>(),
      recentCompactionAt: null,
      lastInjectedMemoryIds: new Set<string>(),
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
 */
export function ensureBootstrap(tiers: Set<ToolTier> | null): Set<ToolTier> | null {
  if (tiers === null) return null;
  const out = new Set(tiers);
  out.add('bootstrap');
  return out;
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
