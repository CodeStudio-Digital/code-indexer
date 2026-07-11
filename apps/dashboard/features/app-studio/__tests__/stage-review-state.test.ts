import { describe, expect, it } from 'vitest';
import type { AppPipelineStage } from '../app-studio-api.js';
import { isStageApprovalBlocked, stageBlockingIssueCount } from '../stage-review-state.js';

function stage(overrides: Partial<AppPipelineStage> = {}): AppPipelineStage {
  return {
    id: 'database',
    status: 'active',
    summary: null,
    gate: null,
    feedback: null,
    submitted_at: null,
    approved_at: null,
    ...overrides,
  };
}

describe('App Studio stage review state', () => {
  it('marks a submitted active stage with failed checks as approval-blocked', () => {
    const value = stage({ submitted_at: 'now', gate: { ok: false, issues: ['a', 'b'] } });
    expect(isStageApprovalBlocked(value)).toBe(true);
    expect(stageBlockingIssueCount(value)).toBe(2);
  });

  it('does not label pending work or a review-ready stage as blocked', () => {
    expect(isStageApprovalBlocked(stage())).toBe(false);
    expect(isStageApprovalBlocked(stage({ status: 'review', submitted_at: 'now', gate: { ok: true, issues: [] } }))).toBe(false);
  });
});
