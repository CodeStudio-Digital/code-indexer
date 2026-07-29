import { describe, it, expect } from 'vitest';
import type { SnapshotReviewFinding } from '../snapshot-review-pipeline.js';
import { formatFindingsForAgent } from '../snapshot-review-format.js';

function finding(over: Partial<SnapshotReviewFinding>): SnapshotReviewFinding {
  return {
    severity: 'medium',
    filePath: 'src/a.ts',
    baselineId: '00000000-0000-4000-8000-000000000001',
    hunkFingerprint: null,
    oldLine: null,
    newLine: null,
    body: 'something',
    suggestedFix: null,
    diffExcerpt: null,
    ...over,
  };
}

describe('formatFindingsForAgent', () => {
  it('reports a clean result when there are no findings', () => {
    expect(formatFindingsForAgent([])).toContain('no issues');
  });

  it('orders findings most-severe first and shows file:line', () => {
    const out = formatFindingsForAgent([
      finding({ severity: 'low', filePath: 'low.ts', newLine: 5, body: 'minor' }),
      finding({ severity: 'critical', filePath: 'crit.ts', newLine: 9, body: 'boom' }),
    ]);
    expect(out.indexOf('[critical]')).toBeLessThan(out.indexOf('[low]'));
    expect(out).toContain('crit.ts:9');
  });

  it('includes the suggested fix when present', () => {
    const out = formatFindingsForAgent([finding({ suggestedFix: 'do the thing' })]);
    expect(out).toContain('suggested fix: do the thing');
  });

  it('tells the agent to apply accepted fixes with edit_file', () => {
    const out = formatFindingsForAgent([finding({})]);
    expect(out).toContain('edit_file');
  });
});
