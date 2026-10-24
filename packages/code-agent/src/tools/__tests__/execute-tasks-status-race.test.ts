/**
 * PR-A Bug A (future-proofing): all writes to `statusById` flow through
 * `applyStatus`. Today wave-groups run strictly serially so there is no
 * real race, but the gate exists so the refactor to intra-group
 * parallelism (PR-F or later) only has to touch this one entry-point.
 *
 * This test fires N concurrent `applyStatus` calls against the same
 * map. The current implementation is synchronous (just `Map.set`) and
 * Node's event loop is single-threaded — so the test asserts the WEAKER
 * invariant: regardless of dispatch order, the final state matches the
 * LAST scheduled write per task. When a Mutex lands here, the assertion
 * still holds (it just adds serial ordering).
 */
import { describe, expect, it } from 'vitest';
import { applyStatus, seedStatusById } from '../execute-tasks/task-run-types.js';
import type { CoderTask, TaskStatus } from '@mcp/session-storage/session-state-types.js';

function task(id: string, status: TaskStatus = 'pending'): CoderTask {
  return {
    id,
    title: id,
    description: '',
    files: [],
    references: [],
    depends_on: [],
    suggested_mode: 'subagent',
    estimated_complexity: 'medium',
    kind: 'implement',
    status,
  };
}

describe('applyStatus — single entry-point for statusById writes', () => {
  it('seedStatusById captures initial statuses', () => {
    const m = seedStatusById([
      task('tsk_a', 'pending'),
      task('tsk_b', 'done'),
      task('tsk_c', 'failed'),
    ]);
    expect(m.size).toBe(3);
    expect(m.get('tsk_a')).toBe('pending');
    expect(m.get('tsk_b')).toBe('done');
    expect(m.get('tsk_c')).toBe('failed');
  });

  it('applyStatus overwrites the prior value (last writer wins)', () => {
    const m = seedStatusById([task('tsk_a')]);
    applyStatus(m, 'tsk_a', 'running');
    applyStatus(m, 'tsk_a', 'done');
    expect(m.get('tsk_a')).toBe('done');
  });

  it('applyStatus on an unknown task id adds a new entry', () => {
    const m = seedStatusById([task('tsk_a')]);
    applyStatus(m, 'tsk_unknown', 'skipped');
    expect(m.size).toBe(2);
    expect(m.get('tsk_unknown')).toBe('skipped');
  });

  it('10 concurrent dispatches converge to the last scheduled status', async () => {
    const m = seedStatusById([task('tsk_a')]);
    const sequence: TaskStatus[] = [
      'running', 'failed', 'pending', 'running', 'done',
      'failed', 'pending', 'running', 'skipped', 'done',
    ];

    await Promise.all(
      sequence.map((s, i) =>
        // Real subagent calls await on async work — simulate variable
        // scheduling so the test would catch a "first writer wins" bug
        // if applyStatus ever regressed to non-deterministic ordering.
        new Promise<void>((resolve) => {
          setTimeout(() => {
            applyStatus(m, 'tsk_a', s);
            resolve();
          }, i);
        }),
      ),
    );

    // Last scheduled is 'done' (index 9, fires last under setTimeout(i)).
    expect(m.get('tsk_a')).toBe('done');
  });

  it('parallel dispatches across different task ids do not collide', async () => {
    const m = seedStatusById([
      task('tsk_a'),
      task('tsk_b'),
      task('tsk_c'),
    ]);

    await Promise.all([
      new Promise<void>((r) => setTimeout(() => { applyStatus(m, 'tsk_a', 'done'); r(); }, 0)),
      new Promise<void>((r) => setTimeout(() => { applyStatus(m, 'tsk_b', 'failed'); r(); }, 0)),
      new Promise<void>((r) => setTimeout(() => { applyStatus(m, 'tsk_c', 'skipped'); r(); }, 0)),
    ]);

    expect(m.get('tsk_a')).toBe('done');
    expect(m.get('tsk_b')).toBe('failed');
    expect(m.get('tsk_c')).toBe('skipped');
  });
});
