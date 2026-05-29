/**
 * BehaviorEvent factory functions. Lets node code read as
 * `return events.tokenThresholdHit({ ratio: 0.91 })` instead of scattering
 * object literals throughout the runner.
 */
import type { BehaviorEvent } from './types.js';

export const events = {
  turnSucceeded: (opts: { hasToolCalls: boolean }): BehaviorEvent => ({
    kind: 'TurnSucceeded',
    hasToolCalls: opts.hasToolCalls,
  }),
  tokenThresholdHit: (opts: { ratio: number }): BehaviorEvent => ({
    kind: 'TokenThresholdHit',
    ratio: opts.ratio,
  }),
  toolLoopDetected: (opts: {
    guard: 'tuple-hash' | 'doom-loop' | 'dominance' | 'failure-streak';
  }): BehaviorEvent => ({
    kind: 'ToolLoopDetected',
    guard: opts.guard,
  }),
  maxTurnsReached: (opts: { autoContinueLeft: number }): BehaviorEvent => ({
    kind: 'MaxTurnsReached',
    autoContinueLeft: opts.autoContinueLeft,
  }),
  providerError: (opts: { retryable: boolean; status: number }): BehaviorEvent => ({
    kind: 'ProviderError',
    retryable: opts.retryable,
    status: opts.status,
  }),
  compactionDone: (opts: {
    collapsedFrom: number;
    collapsedTo: number;
  }): BehaviorEvent => ({
    kind: 'CompactionDone',
    collapsedFrom: opts.collapsedFrom,
    collapsedTo: opts.collapsedTo,
  }),
  cleanFinish: (): BehaviorEvent => ({ kind: 'CleanFinish' }),
  aborted: (): BehaviorEvent => ({ kind: 'Aborted' }),
} as const;
