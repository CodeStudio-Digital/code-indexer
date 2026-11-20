/**
 * The end of a background child run reaches the parent as one durable mailbox
 * message, never duplicated: delivery is keyed by the run end and recorded in
 * the app's queue entry. A running parent gets it at its next turn boundary
 * (attachChatMailbox), and an end that happened while the app was down is
 * delivered after the restart. A child the parent waits for sends nothing.
 * (Waking an idle parent is the wake service's part: the host test.)
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { rootChatId } from '@mcp/session-storage/collaboration/store.js';
import { ChildAgentAdmission } from '../child-agent-admission.js';
import { attachChatMailbox } from '../chat-collaboration.js';
import { deliverChildAgentCompletions } from '../child-agent-notices.js';
import { childFixture, type ChildFixture } from './child-agent-fixture.js';

let f: ChildFixture;
const deliver = (childIds?: string[]) => deliverChildAgentCompletions({ queue: f.queue, sessions: f.reads(),
  refresh: (id) => f.app.refreshSession(id), mailbox: f.mailbox, log: () => undefined }, childIds);
const inbox = async () => (await f.mailbox.pending(rootChatId(f.rootId))).filter((message) => message.kind === 'task');

/** A child linked to the root that ran once, as the host's create + run end leave it. */
async function endedChild(key: string, options: { background: boolean; conclude?: boolean }) {
  const id = await f.child(f.rootId, key);
  await f.holdLease(id);
  for (const [session, title] of [[f.rootId, 'Root'], [id, key]] as const) {
    if (!await f.mailbox.participant(rootChatId(session))) await f.mailbox.registerRoot(session, title);
  }
  await f.mailbox.linkSessions(f.rootId, id, true);
  const admission = new ChildAgentAdmission({ sessions: f.reads(), queue: f.queue });
  await admission.request(id, `task ${key}`, { background: options.background });
  await admission.admit(f.rootId);
  if (options.conclude !== false) await f.conclude(id, `${key} is done.`);
  await admission.release(id, options.conclude === false ? 'start_failed' : 'completed');
  return id;
}

beforeEach(async () => { f = await childFixture('child-agent-notices-'); });
afterEach(async () => { await f.close(); });

describe('background child-agent completion notices', () => {
  it('sends one bounded notice per run end, and nothing for a child the parent waits for', async () => {
    const bg = await endedChild('bg', { background: true });
    const waited = await endedChild('waited', { background: false });
    expect(await deliver()).toEqual([bg]);
    expect(await deliver()).toEqual([]);
    expect(await deliver([bg, waited])).toEqual([]);
    const [notice, ...rest] = await inbox();
    expect(rest).toEqual([]);
    expect(notice).toMatchObject({ from: rootChatId(bg), to: rootChatId(f.rootId), kind: 'task', status: 'queued' });
    expect(notice!.body).toContain(`Chat ${bg}: completed`);
    expect(notice!.body).toContain('bg is done.');
    expect((await f.queue.get(bg)).notified_release_at).toBe((await f.queue.get(bg)).released_at);
  });

  it('tells the parent a background child that never ran failed', async () => {
    const bg = await endedChild('bg', { background: true, conclude: false });
    expect(await deliver()).toEqual([bg]);
    expect((await inbox())[0]!.body).toContain(`Chat ${bg}: failed (start_failed)`);
  });

  it('delivers a run end that happened while the app was down, once, after the restart', async () => {
    const bg = await endedChild('bg', { background: true });
    await f.restart();
    expect(await deliver()).toEqual([bg]);
    await f.restart();
    expect(await deliver()).toEqual([]);
    expect(await inbox()).toHaveLength(1);
  });

  it('is never duplicated when the send happened but its record did not', async () => {
    const bg = await endedChild('bg', { background: true });
    expect(await deliver()).toEqual([bg]);
    await f.queue.update(bg, (entry) => ({ ...entry, notified_release_at: null })); // the app died before recording it
    expect(await deliver()).toEqual([bg]); // same idempotency key: the mailbox returns the existing message
    expect(await inbox()).toHaveLength(1);
  });

  it('reaches a running parent at its next turn boundary', async () => {
    const pushed: string[] = [];
    const runner = { pushUserMessage: (text: string) => { pushed.push(text); }, hasPendingUserMessages: () => pushed.length > 0, messages: [] };
    const root = (await f.mailbox.participant(rootChatId(f.rootId))) ?? await f.mailbox.registerRoot(f.rootId, 'Root');
    const close = await attachChatMailbox(f.mailbox, root, runner);
    try {
      const bg = await endedChild('bg', { background: true });
      await deliver();
      await expect.poll(() => pushed.length, { timeout: 2_000 }).toBe(1);
      expect(pushed[0]).toContain('<agent_message>');
      expect(pushed[0]).toContain(`Chat ${bg}: completed`);
    } finally {
      await close();
    }
  });
});
