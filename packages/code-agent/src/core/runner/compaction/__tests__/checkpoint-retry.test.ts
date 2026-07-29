import { describe, expect, it, vi } from 'vitest';
import type {
  CompactionCheckpoint,
  CompactionCheckpointResult,
} from '@mcp/code-agent/core/runner/types.js';
import { DurableCheckpointCoordinator } from '../checkpoint-retry.js';

function checkpoint(trigger: string): CompactionCheckpoint {
  return {
    summary: {
      version: 3,
      chapter: {
        title: trigger, summary: '', user_requests: [], decisions: [],
        work_completed: [], files: [], open_issues: [], resolved_issues: [],
      },
      resume: {
        objective: trigger, current_focus: '', constraints: [], pending_tasks: [], next_step: '',
      },
    },
    headMessages: [],
    trigger,
    autoContinues: 0,
  };
}

describe('DurableCheckpointCoordinator', () => {
  it('does not retry an unaligned noop and permits a later checkpoint', async () => {
    const commit = vi.fn<(
      value: CompactionCheckpoint,
    ) => Promise<CompactionCheckpointResult>>()
      .mockResolvedValueOnce({ status: 'noop', reason: 'unaligned' })
      .mockResolvedValueOnce({
        status: 'committed',
        chapterId: '00000000-0000-4000-8000-000000000002',
        boundaryId: 20,
      });
    const coordinator = new DurableCheckpointCoordinator(commit);

    expect(await coordinator.submit(checkpoint('first'), 10)).toMatchObject({ status: 'noop' });
    expect(coordinator.hasPending).toBe(false);
    expect(await coordinator.retry(100)).toBeNull();
    expect(await coordinator.submit(checkpoint('second'), 11)).toMatchObject({ status: 'committed' });
    expect(commit.mock.calls.map(([value]) => value.trigger)).toEqual(['first', 'second']);
  });

  it('backs off transient retries and caps the total attempt count', async () => {
    const commit = vi.fn<(
      value: CompactionCheckpoint,
    ) => Promise<CompactionCheckpointResult>>()
      .mockResolvedValue({ status: 'failed', reason: 'database busy' });
    const coordinator = new DurableCheckpointCoordinator(commit, {
      maxAttempts: 3,
      baseBackoffTurns: 2,
    });

    await coordinator.submit(checkpoint('transient'), 10);
    expect(await coordinator.retry(11)).toBeNull();
    expect((await coordinator.retry(12))?.attempt).toBe(2);
    expect(await coordinator.retry(15)).toBeNull();
    expect((await coordinator.retry(16))?.attempt).toBe(3);
    expect(coordinator.hasPending).toBe(false);
    expect(await coordinator.retry(100)).toBeNull();
    expect(commit).toHaveBeenCalledTimes(3);
  });

  it('rebases by superseding a stale pending checkpoint with the newest one', async () => {
    const commit = vi.fn<(
      value: CompactionCheckpoint,
    ) => Promise<CompactionCheckpointResult>>()
      .mockResolvedValueOnce({ status: 'failed', reason: 'database busy' })
      .mockResolvedValueOnce({
        status: 'committed',
        chapterId: '00000000-0000-4000-8000-000000000003',
        boundaryId: 30,
      });
    const coordinator = new DurableCheckpointCoordinator(commit);

    await coordinator.submit(checkpoint('old'), 1);
    expect(coordinator.hasPending).toBe(true);
    await coordinator.submit(checkpoint('new'), 2);
    expect(coordinator.hasPending).toBe(false);
    expect(commit.mock.calls.map(([value]) => value.trigger)).toEqual(['old', 'new']);
  });
});
