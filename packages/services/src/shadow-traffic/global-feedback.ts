/**
 * Module-level holder for the global `FeedbackCollector`.
 *
 * Cross-cutting hook so runtime call-sites (master spawn, runner turn
 * end, kanban moveCard…) can backfill counterfactual rows without
 * threading the collector through deep service boundaries.
 *
 * Installed by the boot path; observed by tools that don't have direct
 * access to deps.
 */
import type { FeedbackCollector } from './feedback-collector.js';

let globalCollector: FeedbackCollector | undefined;

export function setGlobalFeedbackCollector(collector: FeedbackCollector | undefined): void {
  globalCollector = collector;
}

export function getGlobalFeedbackCollector(): FeedbackCollector | undefined {
  return globalCollector;
}

/**
 * Convenience helper — wrap an observe call so callers don't need to
 * null-check the collector. Safe to call when no collector is
 * installed; returns 0 in that case.
 */
export function observeOutcome(
  pipelineName: string,
  event: Record<string, unknown> & { queryHash: string },
): number {
  if (!globalCollector) return 0;
  try {
    return globalCollector.observe(pipelineName, event);
  } catch {
    return 0;
  }
}
