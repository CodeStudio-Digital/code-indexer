/**
 * ToolSelectionOutcomeMatcher focused tests — no DB/native sqlite required.
 */
import { describe, expect, it } from 'vitest';
import type { CounterfactualLogRow } from '@mcp/store/counterfactual-log-store.js';
import { ToolSelectionOutcomeMatcher } from '../feedback-collector.js';

function row(overrides: Partial<CounterfactualLogRow> = {}): CounterfactualLogRow {
  return {
    id: 1,
    pipeline_name: 'tool_selection',
    shadow_variant: 'k_8',
    query_hash: 'q1',
    production_choice_json: null,
    shadow_prediction_json: null,
    true_outcome_json: null,
    outcome_confidence: null,
    outcome_observed_at: null,
    created_at: '2025-01-01 00:00:00',
    ...overrides,
  };
}

describe('ToolSelectionOutcomeMatcher', () => {
  it('preserves legacy outcome shape when agentDecision is omitted', () => {
    const matcher = new ToolSelectionOutcomeMatcher();
    const [match] = matcher.match(
      { queryHash: 'q1', toolsCalled: ['Read', 'Edit'] },
      [row()],
    );

    expect(match).toEqual({
      id: 1,
      true_outcome: { toolsCalled: ['Read', 'Edit'] },
    });
  });

  it('adds optional agentDecision metadata to true_outcome when provided', () => {
    const matcher = new ToolSelectionOutcomeMatcher();
    const agentDecision = {
      recommendedAgent: 'build',
      intent: 'edit',
      phase: 'editing',
      riskBudget: 'write',
      costBudget: 'medium',
      delegation: 'inline',
      confidence: 0.9,
      requiresExplicitUserIntent: false,
      toolPolicyPreferredCount: 5,
      toolPolicyDiscouragedCount: 3,
    };
    const [match] = matcher.match(
      { queryHash: 'q1', toolsCalled: ['Read', 'Edit'], agentDecision },
      [row({ id: 42 })],
    );

    expect(match).toEqual({
      id: 42,
      true_outcome: { toolsCalled: ['Read', 'Edit'], agentDecision },
    });
  });
});
