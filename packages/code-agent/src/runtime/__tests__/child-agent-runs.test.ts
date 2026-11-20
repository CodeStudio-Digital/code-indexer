/**
 * Starting child-agent runs: a requested child starts when its tree has a
 * slot, the end of a run starts the next one, a start failure frees its slot,
 * after a restart the boot resume starts each admitted child once (the start
 * key makes a re-delivered start a no-op), and an entry whose child is gone
 * is released. Two store instances; the worker holds every child's lease.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ChildAgentAdmission } from '../child-agent-admission.js';
import { ChildAgentRunService, type ChildAgentLauncher } from '../child-agent-runs.js';
import { childFixture, type ChildFixture } from './child-agent-fixture.js';

let f: ChildFixture;
/** Runs the "app" accepted, deduplicated by start key like the local command admission. */
const accepted = new Map<string, string>();
const live = new Set<string>();
function launcher(fail?: (childId: string) => boolean): ChildAgentLauncher & { starts: string[] } {
  const starts: string[] = [];
  return {
    starts,
    isRunning: (id) => live.has(id),
    async start({ childId, task, startKey }) {
      if (fail?.(childId)) throw new Error('worker unavailable');
      if (accepted.has(startKey)) return;
      accepted.set(startKey, task);
      live.add(childId);
      starts.push(childId);
    },
  };
}
function service(start: ChildAgentLauncher) {
  return new ChildAgentRunService({ sessions: f.reads(),
    admission: new ChildAgentAdmission({ sessions: f.reads(), queue: f.queue, isRunning: start.isRunning }), launcher: start, log: () => undefined });
}
async function child(key: string) {
  const id = await f.child(f.rootId, key);
  await f.holdLease(id);
  return id;
}

beforeEach(async () => {
  f = await childFixture('child-agent-runs-');
  accepted.clear();
  live.clear();
});
afterEach(async () => { await f.close(); });

describe('child-agent runs', () => {
  it('starts what the tree admits, with its task, and the next one when a run ends', async () => {
    const start = launcher();
    const runs = service(start);
    const ids = [await child('a'), await child('b'), await child('c'), await child('d')];
    for (const id of ids) await runs.request(id, `task of ${id}`);
    expect(start.starts).toEqual(ids.slice(0, 3));
    expect([...accepted.values()]).toEqual(ids.slice(0, 3).map((id) => `task of ${id}`));
    expect(await f.queue.get(ids[3]!)).toMatchObject({ state: 'queued', task: `task of ${ids[3]}` });

    live.delete(ids[0]!);
    await runs.ended(ids[0]!, 'succeeded');
    expect(start.starts).toEqual(ids);
    expect(await f.queue.get(ids[0]!)).toMatchObject({ state: 'released', release_reason: 'succeeded' });
  });

  it('frees the slot of a start that fails and moves on', async () => {
    const [a, b] = [await child('a'), await child('b')];
    const start = launcher((id) => id === a);
    const runs = service(start);
    await runs.request(a, 'first');
    expect(await f.queue.get(a)).toMatchObject({ state: 'released', release_reason: 'start_failed' });
    await runs.request(b, 'second');
    expect(start.starts).toEqual([b]);
  });

  it('after a restart, resumes queued trees and starts each admitted child once', async () => {
    const ids = [await child('a'), await child('b'), await child('c'), await child('d')];
    const before = launcher();
    for (const id of ids) await service(before).request(id, `task of ${id}`);
    expect(before.starts).toEqual(ids.slice(0, 3));

    // The app restarts (and the children's worker with it): nothing is live, the accepted keys survive.
    await f.restart();
    for (const id of ids) await f.holdLease(id);
    live.clear();
    const after = launcher();
    expect(await service(after).resume()).toBe(1);
    expect(after.starts).toEqual([]);
    expect(accepted.size).toBe(3);
    expect((await f.queue.get(ids[3]!)).state).toBe('queued');
  });

  it('releases the queue entry of a child that was deleted', async () => {
    const [a, b] = [await child('a'), await child('b')];
    const start = launcher();
    await new ChildAgentAdmission({ sessions: f.reads(), queue: f.queue }).request(a, 'never runs');
    await f.worker.close(); // the worker lets go of the bundle before the user deletes it
    await f.app.deleteSession(a);
    expect(await service(start).resume()).toBe(0);
    expect(await f.queue.get(a)).toMatchObject({ state: 'released', release_reason: 'orphaned' });
    await service(start).request(b, 'runs');
    expect(start.starts).toEqual([b]);
  });
});
