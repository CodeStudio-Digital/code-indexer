import { describe, it, expect } from 'vitest';
import { recordSessionFates, buildReviewPriors } from '../review-fates.js';
import type { SessionFileReviewStore } from '@mcp/store/session-file-review-store.js';
import type { ReviewFateInput, ReviewIntelStore, ReviewFateAggregate, RecentDismissal } from '@mcp/store/review-intel-store.js';
import type { FileDiff } from '../session-snapshots.js';

function comment(over: Partial<Record<string, unknown>>): Record<string, unknown> {
  return {
    id: 1,
    status: 'open',
    kind: 'defect',
    severity: 'medium',
    file_path: 'src/a.ts',
    hunk_fingerprint: 'fp1',
    ...over,
  };
}

function diffWith(filePath: string, fingerprints: string[]): FileDiff {
  return {
    baseline: { id: 1, filePath, existedBefore: true, oversized: false, status: 'active' },
    hunks: fingerprints.map((fingerprint) => ({ fingerprint, decision: 'pending' })),
    diffDisabled: false,
    currentContent: '',
  } as unknown as FileDiff;
}

function intelStub(aggregates: ReviewFateAggregate[] = [], dismissals: RecentDismissal[] = []) {
  const fates: ReviewFateInput[] = [];
  const store = {
    recordFate: (f: ReviewFateInput) => fates.push(f),
    aggregateFates: () => aggregates,
    recentDismissals: () => dismissals,
  } as unknown as ReviewIntelStore;
  return { store, fates };
}

describe('recordSessionFates', () => {
  it('classifies accepted, dismissed, re-edited and ignored comments', () => {
    const comments = [
      comment({ id: 1, status: 'accepted' }),
      comment({ id: 2, status: 'dismissed' }),
      // fp-gone no longer exists among the file's current hunks → re-edited.
      comment({ id: 3, status: 'open', hunk_fingerprint: 'fp-gone' }),
      // fp1 still present and comment still open → ignored (so far).
      comment({ id: 4, status: 'open', hunk_fingerprint: 'fp1' }),
    ];
    const reviewStore = {
      listComments: () => comments,
    } as unknown as SessionFileReviewStore;
    const { store, fates } = intelStub();
    recordSessionFates(reviewStore, store, 'coder', 42, [diffWith('src/a.ts', ['fp1', 'fp2'])]);
    const byId = new Map(fates.map((f) => [f.comment_id, f.outcome]));
    expect(byId.get(1)).toBe('accepted');
    expect(byId.get(2)).toBe('dismissed');
    expect(byId.get(3)).toBe('reedited');
    expect(byId.get(4)).toBe('ignored');
  });

  it('never throws when the store fails', () => {
    const reviewStore = {
      listComments: () => {
        throw new Error('table missing');
      },
    } as unknown as SessionFileReviewStore;
    const { store } = intelStub();
    expect(() => recordSessionFates(reviewStore, store, 'coder', 1, [])).not.toThrow();
  });
});

describe('buildReviewPriors', () => {
  const agg = (over: Partial<ReviewFateAggregate>): ReviewFateAggregate => ({
    category: 'defect',
    severity: 'low',
    accepted: 0,
    dismissed: 0,
    reedited: 0,
    ignored: 0,
    total: 0,
    ...over,
  });

  it('suppresses low-precision categories but never critical', () => {
    const { store } = intelStub([
      agg({ category: 'defect', severity: 'low', accepted: 1, dismissed: 9 }),
      agg({ category: 'defect', severity: 'critical', accepted: 0, dismissed: 20 }),
    ]);
    const text = buildReviewPriors(store)!;
    expect(text).toContain('severity "low"');
    expect(text).toContain('dismissed 9/10');
    expect(text).not.toContain('critical');
  });

  it('needs enough explicit verdicts before suppressing', () => {
    const { store } = intelStub([
      agg({ category: 'defect', severity: 'low', accepted: 0, dismissed: 3 }), // n=3 < 5
    ]);
    expect(buildReviewPriors(store)).toBeNull();
  });

  it('includes recent dismissals as few-shot negatives', () => {
    const { store } = intelStub(
      [],
      [{ body: 'style nit about naming', file_path: 'src/x.ts', severity: 'low', kind: 'defect' }],
    );
    const text = buildReviewPriors(store)!;
    expect(text).toContain('Recently dismissed');
    expect(text).toContain('style nit about naming');
  });

  it('returns null on a cold start', () => {
    const { store } = intelStub();
    expect(buildReviewPriors(store)).toBeNull();
  });
});
