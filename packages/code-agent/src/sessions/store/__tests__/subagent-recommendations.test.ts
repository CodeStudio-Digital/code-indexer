import { describe, expect, it } from 'vitest';
import {
  recommendSubagentBudgets,
  type CompletedSubagentSample,
} from '../subagent-recommendations.js';

const DAY = 24 * 60 * 60 * 1000;

function samples(profile: string, count: number, spanDays: number): CompletedSubagentSample[] {
  return Array.from({ length: count }, (_, index) => ({
    profile,
    turns: index >= count - 2 ? 80 : 20,
    logicalOperations: index >= count - 2 ? 60 : 16,
    elapsedMs: index >= count - 2 ? 600_000 : 120_000,
    startedAtMs: (index / Math.max(1, count - 1)) * spanDays * DAY,
    completedAtMs: (index / Math.max(1, count - 1)) * spanDays * DAY + 1_000,
  }));
}

describe('recommendSubagentBudgets', () => {
  it('waits for at least 50 completed samples', () => {
    expect(recommendSubagentBudgets(samples('review', 49, 20))).toEqual([]);
  });

  it('waits for at least 14 days of observation', () => {
    expect(recommendSubagentBudgets(samples('review', 50, 13))).toEqual([]);
  });

  it('adds at least 25% above the p99', () => {
    const [result] = recommendSubagentBudgets(samples('review', 100, 20));
    expect(result.p99).toEqual({ turns: 80, logicalOperations: 60, durationMs: 600_000 });
    expect(result.recommended).toEqual({
      maxTurns: 100,
      maxLogicalOperations: 75,
      timeoutMs: 750_000,
    });
  });

  it('keeps explore unlimited by logical operations', () => {
    const [result] = recommendSubagentBudgets(samples('explore', 50, 20));
    expect(result.recommended.maxLogicalOperations).toBeNull();
  });
});
