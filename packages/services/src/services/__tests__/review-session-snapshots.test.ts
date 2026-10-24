/**
 * Unit tests for the shared `reviewSessionSnapshots` use-case.
 *
 * Uses duck-typed fakes for the stores/service/pipeline (no real DB) so the
 * test pins the orchestration: list baselines → diff → count pending hunks →
 * call the pipeline → persist comments → propagate errors.
 */
import { describe, it, expect } from 'vitest';
import type {
  SessionReviewStorePort,
  SessionSnapshotStorePort,
} from '../session-snapshot-port.js';
import type { SessionSnapshotService } from '../session-snapshots.js';
import type {
  SnapshotReviewFinding,
  SnapshotReviewPipeline,
  SnapshotReviewResult,
} from '../snapshot-review-pipeline.js';
import { reviewSessionSnapshots } from '../review-session-snapshots.js';

const SESSION_ID = '10000000-0000-4000-8000-000000000042';
const BASELINE_ID = '20000000-0000-4000-8000-000000000010';
const REVIEW_RUN_ID = '30000000-0000-4000-8000-000000000001';

function fakeDiff() {
  return {
    baseline: {
      id: BASELINE_ID,
      filePath: 'src/a.ts',
      existedBefore: true,
      oversized: false,
      status: 'active' as const,
    },
    hunks: [
      {
        fingerprint: 'fp1',
        oldStart: 1,
        oldLines: 1,
        newStart: 1,
        newLines: 1,
        addedCount: 1,
        removedCount: 0,
        lines: [{ type: 'add' as const, oldLine: null, newLine: 1, content: 'const x = 1;' }],
        decision: 'pending' as const,
      },
    ],
    diffDisabled: false,
    currentContent: 'const x = 1;',
  };
}

const FINDING: SnapshotReviewFinding = {
  severity: 'high',
  filePath: 'src/a.ts',
  baselineId: BASELINE_ID,
  hunkFingerprint: 'fp1',
  oldLine: null,
  newLine: 1,
  body: 'x is unused',
  suggestedFix: 'remove it',
  diffExcerpt: null,
};

function snapshotStoreWith(
  baselineIds: string[],
): SessionSnapshotStorePort<string, string> {
  return {
    listActiveBaselineIds: () => baselineIds,
  } as unknown as SessionSnapshotStorePort<string, string>;
}

function snapshotServiceWith(
  diff: ReturnType<typeof fakeDiff> | null,
): SessionSnapshotService<string, string> {
  return {
    getDiff: async () => diff,
  } as unknown as SessionSnapshotService<string, string>;
}

function pipelineReturning(
  result: SnapshotReviewResult,
  onCall?: (input: unknown) => void,
): SnapshotReviewPipeline {
  return {
    review: async (input: unknown) => {
      onCall?.(input);
      return result;
    },
  } as unknown as SnapshotReviewPipeline;
}

function makeReviewStore() {
  const runs: Array<Record<string, unknown>> = [];
  const completed: Array<{ id: string; patch: Record<string, unknown> }> = [];
  const comments: Array<Record<string, unknown>> = [];
  const store = {
    createRun: (i: Record<string, unknown>) => {
      const r = { id: REVIEW_RUN_ID, ...i };
      runs.push(r);
      return r;
    },
    completeRun: (id: string, patch: Record<string, unknown>) => completed.push({ id, patch }),
    createComment: (i: Record<string, unknown>) => {
      const c = {
        id: `40000000-0000-4000-8000-${String(comments.length + 1).padStart(12, '0')}`,
        ...i,
      };
      comments.push(c);
      return c;
    },
  } as unknown as SessionReviewStorePort<string, string>;
  return { store, runs, completed, comments };
}

describe('reviewSessionSnapshots', () => {
  it('does not create a run when ownership changes during diff preparation', async () => {
    const rs = makeReviewStore(); let owned = true, reviewed = false;
    await expect(reviewSessionSnapshots({ snapshotStore: snapshotStoreWith([BASELINE_ID]),
      snapshotService: { getDiff: async () => { owned = false; return fakeDiff(); } } as never,
      pipeline: pipelineReturning({ ok: true, findings: [], raw: '{}' }, () => { reviewed = true; }),
      reviewStore: rs.store }, SESSION_ID, { assertOwner: () => { if (!owned) throw new Error('owner retired'); } }))
      .rejects.toThrow('owner retired');
    expect(rs.runs).toEqual([]); expect(rs.comments).toEqual([]); expect(reviewed).toBe(false);
  });
  it('discards late findings without writing through a retired owner', async () => {
    const rs = makeReviewStore(); let owned = true;
    await expect(reviewSessionSnapshots({ snapshotStore: snapshotStoreWith([BASELINE_ID]),
      snapshotService: snapshotServiceWith(fakeDiff()),
      pipeline: pipelineReturning({ ok: true, findings: [FINDING], raw: '{}' }, () => { owned = false; }),
      reviewStore: rs.store }, SESSION_ID, { assertOwner: () => { if (!owned) throw new Error('owner retired'); } }))
      .rejects.toThrow('owner retired');
    expect(rs.runs).toHaveLength(1); expect(rs.comments).toEqual([]); expect(rs.completed).toEqual([]);
  });
  it('closes the owned run as cancelled and discards late provider findings', async () => {
    const controller = new AbortController();
    const rs = makeReviewStore();
    const pipeline = pipelineReturning({ ok: true, findings: [FINDING], raw: '{}' }, (input) => {
      expect((input as { signal: AbortSignal }).signal).toBe(controller.signal);
      controller.abort(new Error('review stopped'));
    });
    await expect(reviewSessionSnapshots({ snapshotStore: snapshotStoreWith([BASELINE_ID]),
      snapshotService: snapshotServiceWith(fakeDiff()), pipeline, reviewStore: rs.store },
      SESSION_ID, { signal: controller.signal })).rejects.toThrow('review stopped');
    expect(rs.comments).toEqual([]);
    expect(rs.completed).toEqual([{ id: REVIEW_RUN_ID, patch: { status: 'error', error: 'Review cancelled.' } }]);
  });
  it('stops preparing later files after cancellation while a diff is loading', async () => {
    const controller = new AbortController();
    let reads = 0, reviewed = false;
    const rs = makeReviewStore();
    await expect(reviewSessionSnapshots({ snapshotStore: snapshotStoreWith([BASELINE_ID, 'later']),
      snapshotService: { getDiff: async () => { reads++; controller.abort(new Error('stop')); return fakeDiff(); } } as never,
      pipeline: pipelineReturning({ ok: true, findings: [], raw: '{}' }, () => { reviewed = true; }),
      reviewStore: rs.store }, SESSION_ID, { signal: controller.signal })).rejects.toThrow('stop');
    expect(reads).toBe(1);
    expect(reviewed).toBe(false);
    expect(rs.runs).toEqual([]);
  });
  it('reviews pending diffs, returns findings, and persists auto comments', async () => {
    let captured: unknown = null;
    const pipeline = pipelineReturning(
      { ok: true, findings: [FINDING], raw: '{"findings":[]}', providerId: 'prov', modelId: 'mod' },
      (input) => (captured = input),
    );
    const rs = makeReviewStore();
    const out = await reviewSessionSnapshots(
      {
        snapshotStore: snapshotStoreWith([BASELINE_ID]),
        snapshotService: snapshotServiceWith(fakeDiff()),
        pipeline,
        reviewStore: rs.store,
      },
      SESSION_ID,
    );

    expect(out.ok).toBe(true);
    expect(out.pendingHunks).toBe(1);
    expect(out.findings).toHaveLength(1);
    expect(captured).toMatchObject({
      sessionKind: 'coder',
      sessionId: SESSION_ID,
      resolveContext: { sessionId: SESSION_ID },
    });
    // Persisted exactly one auto comment on the right baseline/file.
    expect(rs.comments).toHaveLength(1);
    expect(rs.comments[0]).toMatchObject({
      baseline_id: BASELINE_ID,
      source: 'auto',
      file_path: 'src/a.ts',
    });
    expect(rs.completed.at(-1)?.patch.status).toBe('completed');
  });

  it('short-circuits with no pipeline call when there are no pending hunks', async () => {
    let reviewed = false;
    const pipeline = pipelineReturning({ ok: true, findings: [], raw: '' }, () => (reviewed = true));
    const rs = makeReviewStore();
    const out = await reviewSessionSnapshots(
      {
        snapshotStore: snapshotStoreWith([]),
        snapshotService: snapshotServiceWith(null),
        pipeline,
        reviewStore: rs.store,
      },
      SESSION_ID,
    );

    expect(out.pendingHunks).toBe(0);
    expect(out.findings).toEqual([]);
    expect(reviewed).toBe(false);
    expect(rs.completed.at(-1)?.patch.status).toBe('completed');
  });

  it('propagates a config errorCode and records the run as error', async () => {
    const pipeline = pipelineReturning({
      ok: false,
      findings: [],
      raw: '{"findings":[{"severity":"high"}',
      errorCode: 'review_pipeline_unconfigured',
      error: 'Configure snapshot_review/reviewer.',
    });
    const rs = makeReviewStore();
    const out = await reviewSessionSnapshots(
      {
        snapshotStore: snapshotStoreWith([BASELINE_ID]),
        snapshotService: snapshotServiceWith(fakeDiff()),
        pipeline,
        reviewStore: rs.store,
      },
      SESSION_ID,
    );

    expect(out.ok).toBe(false);
    expect(out.errorCode).toBe('review_pipeline_unconfigured');
    expect(rs.completed.at(-1)?.patch.status).toBe('error');
    expect(rs.completed.at(-1)?.patch.raw_response).toBe('{"findings":[{"severity":"high"}');
  });

  it('builds contextText from focus + intent options', async () => {
    let captured: { contextText?: string | null } | null = null;
    const pipeline = pipelineReturning(
      { ok: true, findings: [], raw: '{"findings":[]}' },
      (input) => (captured = input as { contextText?: string | null }),
    );
    const out = await reviewSessionSnapshots(
      {
        snapshotStore: snapshotStoreWith([BASELINE_ID]),
        snapshotService: snapshotServiceWith(fakeDiff()),
        pipeline,
      },
      SESSION_ID,
      { focus: 'watch the null handling', intent: 'Session: fix crash on empty list' },
    );
    expect(out.ok).toBe(true);
    expect(captured!.contextText).toContain('## Task context');
    expect(captured!.contextText).toContain('fix crash on empty list');
    expect(captured!.contextText).toContain('## Author focus');
    expect(captured!.contextText).toContain('watch the null handling');
  });

  it('passes a null contextText when no options and no useful symbols', async () => {
    let captured: { contextText?: string | null } | null = null;
    const pipeline = pipelineReturning(
      { ok: true, findings: [], raw: '{"findings":[]}' },
      (input) => (captured = input as { contextText?: string | null }),
    );
    // fakeDiff's one-line file is fully covered by the hunk window, so the
    // symbol context is empty → legacy prompt (contextText null).
    await reviewSessionSnapshots(
      {
        snapshotStore: snapshotStoreWith([BASELINE_ID]),
        snapshotService: snapshotServiceWith(fakeDiff()),
        pipeline,
      },
      SESSION_ID,
    );
    expect(captured!.contextText).toBeNull();
  });

  it('works without a reviewStore (no persistence)', async () => {
    const pipeline = pipelineReturning({ ok: true, findings: [FINDING], raw: '' });
    const out = await reviewSessionSnapshots(
      {
        snapshotStore: snapshotStoreWith([BASELINE_ID]),
        snapshotService: snapshotServiceWith(fakeDiff()),
        pipeline,
      },
      SESSION_ID,
    );
    expect(out.ok).toBe(true);
    expect(out.findings).toHaveLength(1);
  });

  it('skips .mcp-indexer diffs — no pipeline call when only those changed', async () => {
    let reviewed = false;
    const pipeline = pipelineReturning({ ok: true, findings: [], raw: '' }, () => (reviewed = true));
    const ignored = fakeDiff();
    ignored.baseline.filePath = '.mcp-indexer/trash/deleted.ts';
    const out = await reviewSessionSnapshots(
      {
        snapshotStore: snapshotStoreWith([BASELINE_ID]),
        snapshotService: snapshotServiceWith(ignored),
        pipeline,
      },
      SESSION_ID,
    );
    expect(out.pendingHunks).toBe(0);
    expect(out.findings).toEqual([]);
    expect(reviewed).toBe(false);
  });
});
