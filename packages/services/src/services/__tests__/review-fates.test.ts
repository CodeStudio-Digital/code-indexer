import { describe, it, expect } from 'vitest';
import { recordSessionFates, buildReviewPriors } from '../review-fates.js';
import type {
  ReviewFateAggregate,
  ReviewFateInput,
  RecentDismissal,
  ReviewIntelPort,
} from '../review-intel-port.js';
import type {
  SessionReviewStorePort,
} from '../session-snapshot-port.js';
import type { FileDiff } from '../session-snapshots.js';

const SESSION_ID = '00000000-0000-4000-8000-000000000042';
const RECORD_IDS = [
  '00000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000002',
  '00000000-0000-4000-8000-000000000003',
  '00000000-0000-4000-8000-000000000004',
] as const;

function comment(over: Partial<Record<string, unknown>>): Record<string, unknown> {
  return {
    id: RECORD_IDS[0],
    status: 'open',
    kind: 'defect',
    severity: 'medium',
    file_path: 'src/a.ts',
    hunk_fingerprint: 'fp1',
    ...over,
  };
}

function diffWith(filePath: string, fingerprints: string[]): FileDiff<string> {
  return {
    baseline: {
      id: RECORD_IDS[0],
      filePath,
      existedBefore: true,
      oversized: false,
      status: 'active',
    },
    hunks: fingerprints.map((fingerprint) => ({ fingerprint, decision: 'pending' })),
    diffDisabled: false,
    currentContent: '',
  } as unknown as FileDiff<string>;
}

function intelStub(aggregates: ReviewFateAggregate[] = [], dismissals: RecentDismissal[] = []) {
  const fates: ReviewFateInput<string, string>[] = [];
  const store = {
    recordFate: (f: ReviewFateInput<string, string>) => {
      fates.push(f);
    },
    aggregateFates: () => aggregates,
    recentDismissals: () => dismissals,
  } as unknown as ReviewIntelPort<string, string>;
  return { store, fates };
}

describe('recordSessionFates', () => {
  it('classifies accepted, dismissed, re-edited and ignored comments', async () => {
    const comments = [
      comment({ id: RECORD_IDS[0], status: 'accepted' }),
      comment({ id: RECORD_IDS[1], status: 'dismissed' }),
      // fp-gone no longer exists among the file's current hunks → re-edited.
      comment({ id: RECORD_IDS[2], status: 'open', hunk_fingerprint: 'fp-gone' }),
      // fp1 still present and comment still open → ignored (so far).
      comment({ id: RECORD_IDS[3], status: 'open', hunk_fingerprint: 'fp1' }),
    ];
    const reviewStore = {
      listComments: () => comments,
    } as unknown as SessionReviewStorePort<string, string>;
    const { store, fates } = intelStub();
    await recordSessionFates(
      reviewStore,
      store,
      'coder',
      SESSION_ID,
      [diffWith('src/a.ts', ['fp1', 'fp2'])],
    );
    const byId = new Map(fates.map((f) => [f.comment_id, f.outcome]));
    expect(byId.get(RECORD_IDS[0])).toBe('accepted');
    expect(byId.get(RECORD_IDS[1])).toBe('dismissed');
    expect(byId.get(RECORD_IDS[2])).toBe('reedited');
    expect(byId.get(RECORD_IDS[3])).toBe('ignored');
  });

  it('never throws when the store fails', async () => {
    const reviewStore = {
      listComments: () => {
        throw new Error('table missing');
      },
    } as unknown as SessionReviewStorePort<string, string>;
    const { store } = intelStub();
    await expect(
      recordSessionFates(reviewStore, store, 'coder', SESSION_ID, []),
    ).resolves.toBeUndefined();
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

  it('suppresses low-precision categories but never critical', async () => {
    const { store } = intelStub([
      agg({ category: 'defect', severity: 'low', accepted: 1, dismissed: 9 }),
      agg({ category: 'defect', severity: 'critical', accepted: 0, dismissed: 20 }),
    ]);
    const text = (await buildReviewPriors(store))!;
    expect(text).toContain('severity "low"');
    expect(text).toContain('dismissed 9/10');
    expect(text).not.toContain('critical');
  });

  it('needs enough explicit verdicts before suppressing', async () => {
    const { store } = intelStub([
      agg({ category: 'defect', severity: 'low', accepted: 0, dismissed: 3 }), // n=3 < 5
    ]);
    await expect(buildReviewPriors(store)).resolves.toBeNull();
  });

  it('includes recent dismissals as few-shot negatives', async () => {
    const { store } = intelStub(
      [],
      [{ body: 'style nit about naming', file_path: 'src/x.ts', severity: 'low', kind: 'defect' }],
    );
    const text = (await buildReviewPriors(store))!;
    expect(text).toContain('Recently dismissed');
    expect(text).toContain('style nit about naming');
  });

  it('returns null on a cold start', async () => {
    const { store } = intelStub();
    await expect(buildReviewPriors(store)).resolves.toBeNull();
  });
});
