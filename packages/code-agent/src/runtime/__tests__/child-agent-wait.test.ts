/**
 * Waiting for child agents reads durable state only: the queue entry in the
 * app's files and the conclusion the child's worker recorded in its bundle
 * (re-read from disk, since the worker is another store instance). The wait
 * returns the same recorded result after both sides restart, reports queue
 * and run states on timeout, and returns early on a question or an approval.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { rootChatId } from '@mcp/session-storage/collaboration/store.js';
import { ChildAgentAdmission } from '../child-agent-admission.js';
import { mailboxQuestions, waitForChildAgents, type ChildAgentWaitDeps } from '../child-agent-wait.js';
import { SUBAGENT_TOOL_RESULT_CAP } from '../../core/runner.js';
import { childFixture, type ChildFixture } from './child-agent-fixture.js';

let f: ChildFixture, a: string, b: string;
const deps = (extra: Partial<ChildAgentWaitDeps> = {}): ChildAgentWaitDeps =>
  ({ sessions: f.reads(), queue: f.queue, refresh: (id) => f.app.refreshSession(id), ...extra });

beforeEach(async () => {
  f = await childFixture('child-agent-wait-');
  a = await f.child(f.rootId, 'a');
  b = await f.child(f.rootId, 'b');
  for (const id of [a, b]) await f.holdLease(id);
  const admission = new ChildAgentAdmission({ sessions: f.reads(), queue: f.queue });
  await admission.request(a, 'task a');
  await admission.request(b, 'task b');
  await admission.admit(f.rootId);
});
afterEach(async () => { await f.close(); });

describe('waiting for child agents', () => {
  it('returns the conclusion the child worker recorded, and the same after both sides restart', async () => {
    await f.conclude(a, 'Found it.');
    const first = await waitForChildAgents(deps(), { chatIds: [a], timeoutMs: 2_000, pollMs: 20 });
    expect(first).toMatchObject({ outcome: 'ready', items: [{ chatId: a, status: 'completed', finalText: 'Found it.',
      changedFiles: ['src/a.ts'], usage: { input_tokens: 10, output_tokens: 4 } }] });
    await f.restart();
    expect(await waitForChildAgents(deps(), { chatIds: [a], timeoutMs: 2_000, pollMs: 20 })).toEqual(first);
  });

  it('reports queued and running children on timeout, and an older conclusion never answers a newer task', async () => {
    await f.conclude(a, 'Old answer.', new Date(Date.now() - 60_000));
    const c = await f.child(f.rootId, 'c');
    await new ChildAgentAdmission({ sessions: f.reads(), queue: f.queue, maxRunning: 2 }).request(c, 'task c');
    const result = await waitForChildAgents(deps(), { chatIds: [a, c], mode: 'any', timeoutMs: 80, pollMs: 20 });
    expect(result.outcome).toBe('timeout');
    expect(result.items.map((item) => item.status)).toEqual(['running', 'queued']);
  });

  it('waits for any or for all of a set', async () => {
    await f.conclude(a, 'A done.');
    expect((await waitForChildAgents(deps(), { chatIds: [a, b], mode: 'any', timeoutMs: 2_000, pollMs: 20 })).outcome).toBe('ready');
    expect((await waitForChildAgents(deps(), { chatIds: [a, b], mode: 'all', timeoutMs: 80, pollMs: 20 })).outcome).toBe('timeout');
    await f.conclude(b, 'B done.');
    expect((await waitForChildAgents(deps(), { chatIds: [a, b], mode: 'all', timeoutMs: 2_000, pollMs: 20 })).items.map((item) => item.status))
      .toEqual(['completed', 'completed']);
  });

  it('returns early with a question the child asked its parent, or with a pending approval', async () => {
    for (const id of [f.rootId, a]) await f.mailbox.registerRoot(id, id);
    await f.mailbox.linkSessions(f.rootId, a, true);
    await f.mailbox.send({ from: rootChatId(a), to: rootChatId(f.rootId), kind: 'question', body: 'Which branch?', idempotencyKey: 'q1' });
    const asked = await waitForChildAgents(deps({ pendingQuestion: mailboxQuestions(f.mailbox) }), { chatIds: [a, b], mode: 'all', timeoutMs: 2_000, pollMs: 20 });
    expect(asked.items[0]).toMatchObject({ status: 'question', question: { text: 'Which branch?' } });
    const paused = await waitForChildAgents(deps({ awaitingApproval: (id) => id === b }), { chatIds: [b], timeoutMs: 2_000, pollMs: 20 });
    expect(paused.items[0]!.status).toBe('awaiting_approval');
  });

  it('ends when the parent aborts', async () => {
    const parent = new AbortController();
    setTimeout(() => parent.abort(), 50);
    expect((await waitForChildAgents(deps(), { chatIds: [a], timeoutMs: 5_000, pollMs: 20, signal: parent.signal })).outcome).toBe('aborted');
  });

  it('spills a long answer on the parent side and returns it whole otherwise', async () => {
    const long = 'x'.repeat(SUBAGENT_TOOL_RESULT_CAP + 500);
    await f.conclude(a, long);
    const spilled: string[] = [];
    const bounded = await waitForChildAgents(deps({ spill: (text) => { spilled.push(text); return 'out-1'; } }), { chatIds: [a], timeoutMs: 2_000, pollMs: 20 });
    expect(bounded.items[0]).toMatchObject({ outputId: 'out-1' });
    expect(bounded.items[0]!.finalText!.length).toBe(SUBAGENT_TOOL_RESULT_CAP);
    expect(spilled).toEqual([long]);
    expect((await waitForChildAgents(deps(), { chatIds: [a], timeoutMs: 2_000, pollMs: 20 })).items[0]!.finalText).toBe(long);
  });
});
