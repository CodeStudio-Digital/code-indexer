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
import type { ChatUsage } from '@mcp/code-agent/core/messages.js';
import type { ToolTier } from '@mcp/code-agent/tools/tiers.js';
import type { RunnerOptions } from '../types.js';
import type { RecoveryKind } from '../recovery-config.js';
import type { RunContext } from './types.js';

export interface CreateRunContextArgs {
  opts: RunnerOptions;
  emit: RunContext['emit'];
  initialTiers: Set<ToolTier>;
}

export function createRunContext(args: CreateRunContextArgs): RunContext {
  return {
    opts: args.opts,
    emit: args.emit,
    messages: args.opts.initialMessages ? [...args.opts.initialMessages] : [],
    turn: 0,
    totalUsage: zeroUsage(),
    activeTiers: ensureBootstrap(args.initialTiers),
    recovery: new Map(),
    dupCalls: new Map(),
    autoContinues: 0,
    runId: randomUUID(),
    aborted: false,
    transition: null,
    stopReason: null,
    error: null,
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
 * Bootstrap tier is non-negotiable. Compaction / recovery / tier promotion
 * never touch this — the agent always sees the bootstrap tools.
 */
export function ensureBootstrap(tiers: Set<ToolTier>): Set<ToolTier> {
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
