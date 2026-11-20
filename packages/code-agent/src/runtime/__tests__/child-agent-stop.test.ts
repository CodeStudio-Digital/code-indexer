/**
 * Stopping child agents with each child's worker holding its bundle: only an
 * ancestor in the same tree may stop a chat; a stop covers the descendants,
 * aborts live runs, cancels queued ones and closes their mailbox; the freed
 * slot starts the next child, while a stop of the whole tree starts nothing;
 * stopping again changes nothing; and a stop the app began before going down
 * is finished at boot before any tree resumes.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { rootChatId } from '@mcp/session-storage/collaboration/store.js';
import { ChildAgentAdmission } from '../child-agent-admission.js';
import type { ChildAgentQueueStore } from '../child-agent-queue-store.js';
import { ChildAgentRunService } from '../child-agent-runs.js';
import { ChildAgentStops } from '../child-agent-stop.js';
import { childFixture, type ChildFixture } from './child-agent-fixture.js';

let f: ChildFixture;
let live: Set<string>;
let started: string[];
let aborted: string[];

/** The app's machinery over a fake pool: a start is live until aborted, and an abort ends the run. */
function app(queue: ChildAgentQueueStore = f.queue) {
  const isRunning = (id: string) => live.has(id);
  const admission = new ChildAgentAdmission({ sessions: f.reads(), queue, isRunning });
  const service: ChildAgentRunService = new ChildAgentRunService({ sessions: f.reads(), admission, log: () => undefined,
    launcher: { isRunning, async start({ childId }) { started.push(childId); live.add(childId); } } });
  const stops = new ChildAgentStops({ sessions: f.reads(), queue, files: f.mailbox.files, admission, isRunning, log: () => undefined,
    abort: async (id) => { if (live.delete(id)) { aborted.push(id); await service.ended(id, 'cancelled'); } },
    closeMailbox: (id) => f.mailbox.stopSession(id), pump: (id) => service.pump(id) });
  return { service, stops };
}
async function child(parentId: string, key: string) {
  const id = await f.child(parentId, key);
  await f.holdLease(id); // the child's worker owns its bundle from here on
  for (const [session, title] of [[parentId, parentId], [id, key]] as const) {
    if (!await f.mailbox.participant(rootChatId(session))) await f.mailbox.registerRoot(session, title);
  }
  await f.mailbox.linkSessions(parentId, id, true);
  return id;
}

beforeEach(async () => {
  f = await childFixture('child-agent-stop-');
  live = new Set(); started = []; aborted = [];
});
afterEach(async () => { await f.close(); });

describe('stopping child agents', () => {
  it('lets only an ancestor in the same tree stop a chat', async () => {
    const x = await child(f.rootId, 'x');
    const g = await child(x, 'g');
    const y = await child(f.rootId, 'y');
    const other = (await f.app.createSession({ project_id: 1, title: 'Other', provider: 'p1', model: 'm1', agent: 'build' })).id;
    const o = await child(other, 'o');
    const { stops } = app();
    await expect(stops.stopByAncestor(x, [f.rootId])).rejects.toMatchObject({ code: 'not_a_child_agent' }); // a child, its root parent
    await expect(stops.stopByAncestor(g, [x])).rejects.toMatchObject({ code: 'not_an_ancestor' }); // a child, its child-agent parent
    await expect(stops.stopByAncestor(y, [x])).rejects.toMatchObject({ code: 'not_an_ancestor' }); // a sibling
    await expect(stops.stopByAncestor(x, [x])).rejects.toMatchObject({ code: 'not_an_ancestor' }); // itself
    await expect(stops.stopByAncestor(f.rootId, [o])).rejects.toMatchObject({ code: 'not_an_ancestor' }); // another tree
    await expect(stops.stopByAncestor(other, [g])).rejects.toMatchObject({ code: 'not_an_ancestor' });
    for (const id of [x, g, y, o]) expect((await f.queue.get(id)).stop_requested_at ?? null).toBeNull();
    expect(await stops.stopByAncestor(f.rootId, [g])).toEqual([g]); // an ancestor two levels up may
    expect(await f.queue.get(g)).toMatchObject({ stopped_by: f.rootId, stop_reason: 'stopped_by_parent' });
  });

  it('stops a child with its descendants, frees the slot for the next one, and stopping again changes nothing', async () => {
    const [a, b, c, d] = [await child(f.rootId, 'a'), await child(f.rootId, 'b'), await child(f.rootId, 'c'), await child(f.rootId, 'd')];
    const ga = await child(a, 'ga');
    const { service, stops } = app();
    for (const id of [a, b, c, d, ga]) await service.request(id, `task ${id}`);
    expect(started).toEqual([a, b, c]);
    await f.mailbox.send({ from: rootChatId(ga), to: rootChatId(a), kind: 'question', body: 'Which file?', idempotencyKey: 'q1' });

    expect((await stops.stopByAncestor(f.rootId, [a])).sort()).toEqual([a, ga].sort());
    expect(aborted).toEqual([a]);
    expect(started).toEqual([a, b, c, d]); // a's slot went to d; ga, stopped, never started
    expect(await f.queue.get(ga)).toMatchObject({ state: 'released', release_reason: 'stopped', stopped_by: f.rootId });
    expect(await f.queue.get(a)).toMatchObject({ state: 'released', stop_reason: 'stopped_by_parent' });
    for (const id of [a, ga]) expect((await f.mailbox.participant(rootChatId(id)))?.state).toBe('stopped');
    expect((await f.mailbox.pending(rootChatId(a))).filter((message) => message.kind === 'question')).toEqual([]);

    const marks = await Promise.all([a, ga].map((id) => f.queue.get(id)));
    expect((await stops.stopByAncestor(f.rootId, [a])).sort()).toEqual([a, ga].sort());
    expect(aborted).toEqual([a]);
    expect(await Promise.all([a, ga].map((id) => f.queue.get(id)))).toEqual(marks);
  });

  it("the user's Stop on the root stops the whole tree and nothing new starts", async () => {
    const ids = [];
    for (const key of ['a', 'b', 'c', 'd', 'e']) ids.push(await child(f.rootId, key));
    const { service, stops } = app();
    for (const id of ids) await service.request(id, `task ${id}`);
    expect((await stops.stopSession(f.rootId, 'stopped_by_user')).sort()).toEqual([...ids].sort());
    expect(aborted.sort()).toEqual(ids.slice(0, 3).sort());
    expect(started).toEqual(ids.slice(0, 3));
    await service.pump(f.rootId);
    expect(started).toEqual(ids.slice(0, 3));
    expect((await Promise.all(ids.map((id) => f.queue.get(id)))).map((entry) => entry.state)).toEqual(ids.map(() => 'released'));
  });

  it('finishes at boot a stop the app began before going down, and resumes nothing it stopped', async () => {
    const ids = [];
    for (const key of ['a', 'b', 'c']) ids.push(await child(f.rootId, key));
    const before = app();
    for (const id of ids) await before.service.request(id, `task ${id}`);
    expect(started).toEqual(ids);
    let crashed = false;
    const dying: ChildAgentQueueStore = { ...f.queue,
      update: (id, change) => { if (!crashed) { crashed = true; throw new Error('the app went down'); } return f.queue.update(id, change); } };
    await expect(app(dying).stops.stopSession(f.rootId, 'stopped_by_user')).rejects.toThrow('the app went down');
    expect((await f.queue.get(ids[0]!)).stop_requested_at ?? null).toBeNull(); // only the stop record was written

    await f.restart();
    for (const id of ids) await f.holdLease(id);
    live.clear(); // the runs died with the app
    const after = app();
    expect(await after.stops.resume()).toBe(1);
    await after.service.resume();
    expect(started).toEqual(ids); // nothing restarted
    for (const id of ids) expect(await f.queue.get(id)).toMatchObject({ state: 'released', release_reason: 'stopped', stop_reason: 'stopped_by_user' });
    expect(await f.mailbox.files.list('child-agent-stops')).toEqual([]);
    expect(await app().stops.resume()).toBe(0);
  });
});
