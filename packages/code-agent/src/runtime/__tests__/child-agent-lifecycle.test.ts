/**
 * The whole child-agent cycle with each child's worker holding its writer
 * lease from creation to the end: create, queue, admit, start, conclude,
 * release, wait, restart and resume. The app only writes its own files and
 * only reads child bundles; a single app write into a child bundle fails this
 * test with SessionLeaseHeldError.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ChildAgentAdmission } from '../child-agent-admission.js';
import { ChildAgentRunService, type ChildAgentLauncher } from '../child-agent-runs.js';
import { waitForChildAgents } from '../child-agent-wait.js';
import { childFixture, type ChildFixture } from './child-agent-fixture.js';

let f: ChildFixture;
const accepted = new Set<string>();
const live = new Set<string>();
const ran: string[] = [];

/** The app's launcher; the "run" is the child's worker writing to the bundle it owns. */
const launcher: ChildAgentLauncher = {
  isRunning: (id) => live.has(id),
  async start({ childId, startKey }) {
    if (accepted.has(startKey)) return;
    accepted.add(startKey);
    live.add(childId);
    ran.push(childId);
  },
};
async function finishRun(childId: string, answer: string) {
  await f.runRecord(childId, 'running');
  await f.conclude(childId, answer);
  live.delete(childId);
}
const service = () => new ChildAgentRunService({ sessions: f.reads(), launcher, log: () => undefined,
  admission: new ChildAgentAdmission({ sessions: f.reads(), queue: f.queue, isRunning: launcher.isRunning }) });
const wait = (chatIds: string[]) => waitForChildAgents({ sessions: f.reads(), queue: f.queue, refresh: (id) => f.app.refreshSession(id) },
  { chatIds, mode: 'all', timeoutMs: 2_000, pollMs: 20 });

beforeEach(async () => {
  f = await childFixture('child-agent-lifecycle-');
  accepted.clear(); live.clear(); ran.length = 0;
});
afterEach(async () => { await f.close(); });

describe('child-agent lifecycle with the worker owning each child bundle', () => {
  it('never writes a child bundle from the app, across the whole cycle and a restart', async () => {
    const children: string[] = [];
    for (const key of ['a', 'b', 'c', 'd']) {
      const id = await f.child(f.rootId, key);
      await f.holdLease(id); // from here on, the bundle is the worker's
      children.push(id);
    }
    const runs = service();
    for (const id of children) await runs.request(id, `task ${id}`);
    expect(ran).toEqual(children.slice(0, 3));

    await finishRun(children[0]!, 'A is done.');
    await runs.ended(children[0]!, 'completed');
    expect(ran).toEqual(children);
    expect((await wait([children[0]!])).items[0]).toMatchObject({ status: 'completed', finalText: 'A is done.' });

    // App and worker restart mid-cycle; the worker owns its bundles again.
    await f.restart();
    for (const id of children) await f.holdLease(id);
    live.clear();
    await service().resume(); // re-delivers b, c, d with their admission keys: no second run
    expect(ran).toEqual(children);

    for (const id of children.slice(1)) await finishRun(id, `${id} is done.`);
    const restarted = service();
    for (const id of children.slice(1)) await restarted.ended(id, 'completed');
    const all = await wait(children);
    expect(all.items.map((item) => item.status)).toEqual(['completed', 'completed', 'completed', 'completed']);
    expect((await Promise.all(children.map((id) => f.queue.get(id)))).map((entry) => entry.state))
      .toEqual(['released', 'released', 'released', 'released']);
    // The worker still owns every bundle: it can keep writing.
    for (const id of children) await f.worker.setSessionTitle(id, `${id} (done)`);
  });
});
