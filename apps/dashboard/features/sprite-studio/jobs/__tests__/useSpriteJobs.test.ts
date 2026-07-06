import { describe, expect, it } from 'vitest';
import { mergeRestoredJobState, type JobState } from '../useSpriteJobs.js';

const candidate = (index: number) => ({ index, candidateId: `c${index}`, thumbUrl: `/c${index}.png` });

describe('mergeRestoredJobState', () => {
  it('does not regress a terminal SSE state with a stale REST restore', () => {
    const existing: JobState = { status: 'done', pct: 100, candidates: [candidate(0)], versionId: 42 };
    const restored: JobState = { status: 'generating', pct: 0, candidates: [] };

    expect(mergeRestoredJobState(existing, restored)).toBe(existing);
  });

  it('promotes a non-terminal local state when REST is terminal', () => {
    const existing: JobState = { status: 'generating', pct: 35, candidates: [candidate(0), candidate(1)] };
    const restored: JobState = { status: 'failed', pct: 100, candidates: [candidate(0)], error: 'boom' };

    expect(mergeRestoredJobState(existing, restored)).toEqual({
      status: 'failed',
      pct: 100,
      candidates: [candidate(0), candidate(1)],
      error: 'boom',
    });
  });

  it('keeps richer local candidates when merging a fresher REST state', () => {
    const existing: JobState = { status: 'generating', pct: 35, candidates: [candidate(0), candidate(1)] };
    const restored: JobState = { status: 'done', pct: 100, candidates: [candidate(0)], versionId: 99 };

    expect(mergeRestoredJobState(existing, restored)).toEqual({
      status: 'done',
      pct: 100,
      candidates: [candidate(0), candidate(1)],
      versionId: 99,
    });
  });

  it('does not regress live non-terminal progress while adding restored candidates', () => {
    const existing: JobState = { status: 'generating', pct: 65, note: 'live', candidates: [candidate(0)] };
    const restored: JobState = { status: 'queued', pct: 0, candidates: [candidate(0), candidate(1)] };

    expect(mergeRestoredJobState(existing, restored)).toEqual({
      status: 'generating',
      pct: 65,
      note: 'live',
      candidates: [candidate(0), candidate(1)],
    });
  });

  it('keeps restored metadata when live non-terminal state has no fresher value', () => {
    const existing: JobState = { status: 'generating', pct: 65, note: 'live', candidates: [candidate(0)] };
    const restored: JobState = { status: 'generating', pct: 20, candidates: [candidate(0)], versionId: 77, error: 'retrying' };

    expect(mergeRestoredJobState(existing, restored)).toEqual({
      status: 'generating',
      pct: 65,
      note: 'live',
      candidates: [candidate(0)],
      versionId: 77,
      error: 'retrying',
    });
  });
});
