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
  tokenThresholdHit: (opts: { ratio: number; trigger?: string }): BehaviorEvent => ({
    kind: 'TokenThresholdHit',
    ratio: opts.ratio,
    ...(opts.trigger != null ? { trigger: opts.trigger } : {}),
  }),
  toolLoopDetected: (opts: {
    guard: 'tuple-hash' | 'doom-loop' | 'dominance' | 'failure-streak';
    toolName?: string;
    count?: number;
  }): BehaviorEvent => ({
    kind: 'ToolLoopDetected',
    guard: opts.guard,
    ...(opts.toolName != null ? { toolName: opts.toolName } : {}),
    ...(opts.count != null ? { count: opts.count } : {}),
  }),
  maxTurnsReached: (opts: { autoContinueLeft: number }): BehaviorEvent => ({
    kind: 'MaxTurnsReached',
    autoContinueLeft: opts.autoContinueLeft,
  }),
  providerError: (opts: {
    retryable: boolean;
    status: number;
    message?: string;
    code?: string;
  }): BehaviorEvent => ({
    kind: 'ProviderError',
    retryable: opts.retryable,
    status: opts.status,
    ...(opts.message != null ? { message: opts.message } : {}),
    ...(opts.code != null ? { code: opts.code } : {}),
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
  toolOutcomeUnknown: (): BehaviorEvent => ({ kind: 'ToolOutcomeUnknown' }),
  aborted: (): BehaviorEvent => ({ kind: 'Aborted' }),
} as const;
