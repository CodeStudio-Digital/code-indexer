/**
 * After a stop: nothing restarts a stopped child (an implicit request, a
 * message, the boot resume) except an ancestor's explicit new start; a parent
 * waiting for it gets "aborted" at once; a background child whose own chat the
 * user stopped tells its parent once, and one its parent stopped tells nobody;
 * and what an aborted child did (its changed files and usage) reaches the
 * parent like any other conclusion.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { rootChatId } from '@mcp/session-storage/collaboration/store.js';
import type { ToolContext } from '../../core/tool.js';
import { SessionOverlay } from '../../overlay/session-overlay.js';
import { ChildAgentAdmission } from '../child-agent-admission.js';
import { buildConclusion } from '../child-agent-conclusion.js';
import { createChildAgentAccounting } from '../child-agent-freshness.js';
import { deliverChildAgentCompletions } from '../child-agent-notices.js';
import { ChildAgentRunService } from '../child-agent-runs.js';
import { ChildAgentStops } from '../child-agent-stop.js';
import { ChildAgentUsageLedger } from '../child-agent-usage.js';
import { waitForChildAgents } from '../child-agent-wait.js';
import { childFixture, type ChildFixture } from './child-agent-fixture.js';

let f: ChildFixture;
let live: Set<string>;
let starts: string[];

/** A fake pool whose abort leaves the run winding down until `endRun`. */
function app() {
  const isRunning = (id: string) => live.has(id);
  const admission = new ChildAgentAdmission({ sessions: f.reads(), queue: f.queue, isRunning });
  const service: ChildAgentRunService = new ChildAgentRunService({ sessions: f.reads(), admission, log: () => undefined,
    launcher: { isRunning, async start({ childId, startKey }) { starts.push(startKey); live.add(childId); } } });
  const stops = new ChildAgentStops({ sessions: f.reads(), queue: f.queue, files: f.mailbox.files, admission, isRunning, log: () => undefined,
    abort: async () => undefined, closeMailbox: (id) => f.mailbox.stopSession(id), pump: (id) => service.pump(id) });
  const endRun = async (id: string) => { live.delete(id); await service.ended(id, 'cancelled'); };
  return { service, stops, endRun };
}
async function child(key: string) {
  const id = await f.child(f.rootId, key);
  await f.holdLease(id);
  for (const [session, title] of [[f.rootId, 'Root'], [id, key]] as const) {
    if (!await f.mailbox.participant(rootChatId(session))) await f.mailbox.registerRoot(session, title);
  }
  await f.mailbox.linkSessions(f.rootId, id, true);
  return id;
}
const deliver = () => deliverChildAgentCompletions({ queue: f.queue, sessions: f.reads(), refresh: (id) => f.app.refreshSession(id),
  mailbox: f.mailbox, log: () => undefined });
const notices = async () => (await f.mailbox.pending(rootChatId(f.rootId))).filter((message) => message.kind === 'notify');

beforeEach(async () => {
  f = await childFixture('child-agent-stop-after-');
  live = new Set(); starts = [];
});
afterEach(async () => { await f.close(); });

describe('after a child agent is stopped', () => {
  it('stays stopped unless an ancestor explicitly starts it again', async () => {
    const x = await child('x');
    const { service, stops, endRun } = app();
    await service.request(x, 'first task');
    await stops.stopByAncestor(f.rootId, [x]);
    await endRun(x);
    await service.request(x, 'an implicit request');
    expect(starts).toHaveLength(1);
    await expect(f.mailbox.send({ from: rootChatId(f.rootId), to: rootChatId(x), kind: 'task', body: 'More work.', idempotencyKey: 'late' }))
      .rejects.toThrow(/stopped participants cannot receive new work/);
    await f.restart();
    await f.holdLease(x);
    const restarted = app();
    await restarted.stops.resume();
    await restarted.service.resume();
    expect(starts).toHaveLength(1);
    const again = await restarted.service.request(x, 'start over', { restart: true });
    expect(again).toMatchObject({ state: 'admitted', task: 'start over', stop_requested_at: null, stopped_by: null });
    expect(starts).toHaveLength(2);
    expect(starts[1]).not.toBe(starts[0]); // a new admission: a new start key
  });

  it('answers a waiting parent with "aborted" at once, while the run still winds down', async () => {
    const x = await child('x');
    const { service, stops } = app();
    await service.request(x, 'task');
    const waiting = waitForChildAgents({ sessions: f.reads(), queue: f.queue, refresh: (id) => f.app.refreshSession(id) },
      { chatIds: [x], timeoutMs: 10_000, pollMs: 20 });
    const stoppedAt = Date.now();
    await stops.stopByAncestor(f.rootId, [x]);
    const result = await waiting;
    expect(Date.now() - stoppedAt).toBeLessThan(2_000);
    expect(live.has(x)).toBe(true);
    expect(result.items[0]).toMatchObject({ chatId: x, status: 'aborted', reason: 'stopped_by_parent' });
  });

  it("tells the parent once when the user stopped a background child's own chat, and not when the parent stopped it", async () => {
    const [mine, theirs] = [await child('mine'), await child('theirs')];
    const { service, stops, endRun } = app();
    for (const id of [mine, theirs]) await service.request(id, `task ${id}`, { background: true });
    await stops.stopSession(mine, 'stopped_by_user'); // the user pressed Stop in that child's chat
    await stops.stopByAncestor(f.rootId, [theirs]);
    for (const id of [mine, theirs]) await endRun(id);
    expect(await deliver()).toEqual([mine]);
    expect(await deliver()).toEqual([]);
    const [notice, ...rest] = await notices();
    expect(rest).toEqual([]);
    expect(notice).toMatchObject({ from: rootChatId(mine), kind: 'notify' });
    expect(notice!.body).toContain('was stopped by the user');
    expect(notice!.body).toContain(`Chat ${mine}: aborted (stopped_by_user)`);
    expect((await f.queue.get(theirs)).notified_release_at).toBe((await f.queue.get(theirs)).released_at);
  });

  it("counts an aborted child's usage once and makes the files it changed read fresh in the parent", async () => {
    const x = await child('x');
    const { service, stops, endRun } = app();
    await service.request(x, 'task');
    await stops.stopByAncestor(f.rootId, [x]);
    // The child's worker ends the run as aborted: the conclusion keeps what it did so far.
    const runId = randomUUID();
    const fence = await f.worker.startSubagentRun({ session_id: x as never, run_id: runId, profile: 'explore', max_turns: 0 });
    const used = { input_tokens: 30, output_tokens: 6, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
    await f.worker.recordChildAgentConclusion(x, buildConclusion({ runId, state: 'aborted', reason: 'aborted', finalText: null,
      changedFiles: ['src/half-done.ts'], usage: used }));
    await f.worker.completeSubagentRun({ run_id: runId, reason: 'aborted', turns: 1, auto_continues: 0, tool_calls: 1, logical_operations: 0,
      productive_operations: 0, paginate_calls: 0, duplicate_calls: 0, error_calls: 0, refused_calls: 0, elapsed_ms: 1, ...used, has_summary: false, fence });
    await endRun(x);

    const root = join(f.root, 'p1');
    const ctx = { cwd: root, projectName: 'Project 1', projectId: 1, overlay: new SessionOverlay(root) } as ToolContext;
    const accounting = createChildAgentAccounting({ toolContext: ctx, ledger: new ChildAgentUsageLedger(f.rootId, {
      sessions: f.reads(), accounted: () => f.app.listAccountedSubagentKeys(f.rootId),
      recordStandalone: (usage, key) => f.app.bumpSessionUsage(f.rootId, usage, key) }) });
    expect((await accounting.sweep()).map((run) => run.usage)).toEqual([used]);
    expect(ctx.overlay!.isDirty('src/half-done.ts')).toBe(true);
    expect(await accounting.sweep()).toEqual([]);
    const wait = await waitForChildAgents({ sessions: f.reads(), queue: f.queue, refresh: (id) => f.app.refreshSession(id) }, { chatIds: [x], timeoutMs: 0 });
    expect(wait.items[0]).toMatchObject({ status: 'aborted', reason: 'stopped_by_parent', changedFiles: ['src/half-done.ts'] });
  });
});
