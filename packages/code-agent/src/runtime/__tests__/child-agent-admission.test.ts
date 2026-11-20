/**
 * Tree admission: at most 3 child agents of one root run at once (all levels
 * counted), the rest wait in creation order. The queue lives in the app's
 * files and the worker holds every child's writer lease throughout, so any
 * app write into a child bundle fails these tests. No slot leaks: each admit
 * recounts from the queue files, the bundles (conclusion, run records) and
 * isRunning.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ChildAgentAdmission } from '../child-agent-admission.js';
import type { ChildAgentQueueStore } from '../child-agent-queue-store.js';
import { childFixture, type ChildFixture } from './child-agent-fixture.js';

let f: ChildFixture;
let a: string, b: string, a1: string, c: string, d: string;
const ids = (list: Array<{ id: string }>) => list.map((entry) => entry.id);
const admission = (extra: Partial<ConstructorParameters<typeof ChildAgentAdmission>[0]> = {}) =>
  new ChildAgentAdmission({ sessions: f.reads(), queue: f.queue, ...extra });
const state = async (id: string) => (await f.queue.get(id)).state;

beforeEach(async () => {
  f = await childFixture('child-agent-admission-');
  a = await f.child(f.rootId, 'a'); b = await f.child(f.rootId, 'b'); a1 = await f.child(a, 'a1');
  c = await f.child(f.rootId, 'c'); d = await f.child(f.rootId, 'd');
  for (const id of [a, b, a1, c, d]) {
    await f.holdLease(id);
    await admission().request(id, `task ${id}`);
  }
});
afterEach(async () => { await f.close(); });

describe('child-agent tree admission', () => {
  it('admits 3 of the whole tree in creation order and hands each out once', async () => {
    const tree = admission();
    expect(ids(await tree.admit(a1))).toEqual([a, b, a1]);
    expect(await tree.admit(f.rootId)).toEqual([]);
    expect(await state(c)).toBe('queued');
  });

  it('starts the next one when a slot is released and drops a cancelled one from the queue', async () => {
    const tree = admission();
    await tree.admit(f.rootId);
    expect(await tree.cancel(c)).toBe(true);
    expect(await tree.cancel(a)).toBe(false);
    await tree.release(b, 'completed');
    expect(ids(await tree.admit(f.rootId))).toEqual([d]);
    expect(await f.queue.get(c)).toMatchObject({ state: 'released', release_reason: 'cancelled' });
  });

  it('rebuilds the queue after a restart: admitted-but-unstarted children start, queued ones keep their order', async () => {
    await admission().admit(f.rootId);
    await f.restart();
    for (const id of [a, b, a1, c, d]) await f.holdLease(id);
    const restarted = admission();
    expect(ids(await restarted.admit(f.rootId))).toEqual([a, b, a1]);
    await restarted.release(a, 'completed');
    expect(ids(await restarted.admit(f.rootId))).toEqual([c]);
  });

  it('gives back the slot of a run that finished without a release, or whose worker died', async () => {
    const tree = admission({ isRunning: (id) => id === a1 });
    await tree.admit(f.rootId);
    await f.runRecord(a, 'completed');
    await f.runRecord(b, 'running'); // a worker that is gone: not live in this app
    await f.runRecord(a1, 'running');
    expect(ids(await tree.admit(f.rootId))).toEqual([c, d]);
    expect(await state(a)).toBe('released');
    expect((await f.queue.get(b)).release_reason).toBe('interrupted');
    expect(await state(a1)).toBe('admitted');
  });

  it('releases a child that concluded when the app died before releasing it', async () => {
    await admission().admit(f.rootId);
    await f.runRecord(a, 'running');
    await f.conclude(a, 'Done.'); // the run record never completed either
    await f.restart();
    expect(ids(await admission().admit(f.rootId))).toEqual([b, a1, c]);
    expect(await f.queue.get(a)).toMatchObject({ state: 'released', release_reason: 'completed' });
  });

  it('leaks no slot when starting the next one fails after a release', async () => {
    await admission().admit(f.rootId);
    let fail = true;
    const flaky: ChildAgentQueueStore = {
      get: (id) => f.queue.get(id),
      list: () => f.queue.list(),
      update: (id, update) => {
        if (fail && id === c) { fail = false; return Promise.reject(new Error('injected failure before the next start')); }
        return f.queue.update(id, update);
      },
    };
    const crashing = admission({ queue: flaky });
    await crashing.release(a, 'completed');
    await expect(crashing.admit(f.rootId)).rejects.toThrow('injected failure');

    const started = ids(await admission().admit(f.rootId));
    expect(started).toEqual([b, a1, c]);
    const states = await Promise.all([a, b, a1, c, d].map(state));
    expect(states.filter((value) => value === 'admitted')).toHaveLength(3);
  });

  it('never lets an archived child hold or take a slot', async () => {
    const tree = admission();
    await tree.admit(f.rootId);
    await f.worker.setSessionArchived(b, true);
    await f.worker.setSessionArchived(c, true);
    expect(ids(await tree.admit(f.rootId))).toEqual([d]);
    expect(await f.queue.get(b)).toMatchObject({ state: 'released', release_reason: 'orphaned' });
    expect(await f.queue.get(c)).toMatchObject({ state: 'released', release_reason: 'orphaned' });
  });
});
