import { describe, expect, it, vi } from 'vitest';
import { reviewSessionSnapshots, type ReviewSessionDeps } from '../review-session-snapshots.js';
import type { SnapshotReviewResult } from '../snapshot-review-pipeline.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture() {
  const controller = new AbortController();
  const stopped = new Error('review stopped');
  const started = deferred<void>();
  const response = deferred<SnapshotReviewResult>();
  const receipt = vi.fn();
  let owned = true;
  const assertOwner = vi.fn(() => { if (!owned) throw new Error('owner retired'); });
  const createRun = vi.fn(async () => ({ id: 'review-run' }));
  const completeRun = vi.fn(async (_id: string, _patch: unknown): Promise<void> => undefined);
  const createComment = vi.fn(async (_input: unknown) => ({ id: 'review-comment' }));
  const deps = {
    snapshotStore: { listActiveBaselineIds: () => ['baseline'] },
    snapshotService: { getDiff: async () => ({
      baseline: { id: 'baseline', filePath: 'src/a.ts', existedBefore: true, oversized: false, status: 'active' },
      hunks: [{ fingerprint: 'fp', oldStart: 1, oldLines: 1, newStart: 1, newLines: 1,
        addedCount: 1, removedCount: 0, decision: 'pending',
        lines: [{ type: 'add', oldLine: null, newLine: 1, content: 'const x = 1;' }] }],
      diffDisabled: false, currentContent: 'const x = 1;',
    }) },
    pipeline: { review: async () => { started.resolve(); return response.promise; } },
    reviewStore: { createRun, completeRun, createComment },
  } as unknown as ReviewSessionDeps<string, string>;
  const launch = () => {
    const task = reviewSessionSnapshots(deps, 'session', { signal: controller.signal, assertOwner,
      onCancellationSettled: receipt });
    void task.catch(() => undefined);
    return task;
  };
  const result: SnapshotReviewResult = { ok: true, raw: '{}', findings: [{ severity: 'high',
    baselineId: 'baseline', filePath: 'src/a.ts', body: 'Check x', newLine: 1 }] };
  return { controller, stopped, started, response, receipt, assertOwner, createRun, completeRun,
    createComment, launch, result, retireOwner: () => { owned = false; } };
}

describe('review cancellation settlement receipts', () => {
  it('waits for the real provider and durable terminal write before confirming cancellation', async () => {
    const f = fixture(); const committed = deferred<void>(); const committing = deferred<void>();
    f.completeRun.mockImplementation(async () => { committing.resolve(); await committed.promise; });
    const task = f.launch(); await f.started.promise;
    f.controller.abort(f.stopped);
    expect(f.receipt).not.toHaveBeenCalled(); expect(f.completeRun).not.toHaveBeenCalled();
    f.response.resolve(f.result); await committing.promise;
    expect(f.receipt).not.toHaveBeenCalled(); expect(f.createComment).not.toHaveBeenCalled();
    committed.resolve(); await expect(task).rejects.toThrow('review stopped');
    expect(f.completeRun).toHaveBeenCalledExactlyOnceWith('review-run', { status: 'error', error: 'Review cancelled.' });
    expect(f.receipt).toHaveBeenCalledExactlyOnceWith({ runId: 'review-run' });
  });

  it('does not confirm cancellation if terminal persistence fails', async () => {
    const f = fixture(); f.completeRun.mockRejectedValue(new Error('disk full'));
    const task = f.launch(); await f.started.promise;
    f.controller.abort(f.stopped); f.response.resolve(f.result);
    await expect(task).rejects.toThrow('review stopped');
    expect(f.receipt).not.toHaveBeenCalled();
  });

  it('does not erase an ambiguous previous completeRun by succeeding in cleanup', async () => {
    const f = fixture();
    f.completeRun.mockImplementationOnce(async () => {
      f.controller.abort(f.stopped); throw new Error('terminal ACK lost');
    });
    const task = f.launch(); await f.started.promise; f.response.resolve(f.result);
    await expect(task).rejects.toThrow('terminal ACK lost');
    expect(f.completeRun).toHaveBeenCalledTimes(2);
    expect(f.receipt).not.toHaveBeenCalled();
  });

  it('retains uncertainty when a comment write loses its acknowledgement', async () => {
    const f = fixture();
    f.createComment.mockImplementationOnce(async () => {
      f.controller.abort(f.stopped); throw new Error('comment ACK lost');
    });
    const task = f.launch(); await f.started.promise; f.response.resolve(f.result);
    await expect(task).rejects.toThrow('comment ACK lost');
    expect(f.completeRun).toHaveBeenCalledTimes(2);
    expect(f.receipt).not.toHaveBeenCalled();
  });

  it('revalidates ownership after the terminal write acknowledges', async () => {
    const f = fixture(); f.completeRun.mockImplementation(async () => { f.retireOwner(); });
    const task = f.launch(); await f.started.promise;
    f.controller.abort(f.stopped); f.response.resolve(f.result);
    await expect(task).rejects.toThrow('review stopped');
    expect(f.completeRun).toHaveBeenCalledTimes(1);
    expect(f.receipt).not.toHaveBeenCalled();
  });

  it('never confirms a rejected run creation with no authoritative run ID', async () => {
    const f = fixture(); f.createRun.mockImplementation(async () => {
      f.controller.abort(f.stopped); throw new Error('create ACK lost');
    });
    await expect(f.launch()).rejects.toThrow('create ACK lost');
    expect(f.completeRun).not.toHaveBeenCalled(); expect(f.receipt).not.toHaveBeenCalled();
  });

  it('confirms known partial findings only after their writes and terminal error settle', async () => {
    const f = fixture(); const commenting = deferred<void>(); const commentCommitted = deferred<void>();
    f.createComment.mockImplementation(async () => {
      commenting.resolve(); await commentCommitted.promise; return { id: 'review-comment' };
    });
    const task = f.launch(); await f.started.promise; f.response.resolve(f.result);
    await commenting.promise; f.controller.abort(f.stopped);
    expect(f.receipt).not.toHaveBeenCalled(); commentCommitted.resolve();
    await expect(task).rejects.toThrow('review stopped');
    expect(f.completeRun).toHaveBeenLastCalledWith('review-run', { status: 'error', error: 'Review cancelled.' });
    expect(f.receipt).toHaveBeenCalledExactlyOnceWith({ runId: 'review-run' });
  });

  it('does not issue a cancellation receipt for a successful review', async () => {
    const f = fixture(); const task = f.launch(); await f.started.promise; f.response.resolve(f.result);
    await expect(task).resolves.toMatchObject({ ok: true, findings: f.result.findings });
    expect(f.createComment).toHaveBeenCalledTimes(1); expect(f.receipt).not.toHaveBeenCalled();
  });
});
