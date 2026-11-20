/**
 * Why a child failed reaches the app log and the waiting parent: a start that
 * throws is logged with its message and released with it, a run that ended
 * badly carries its reason, and the result the parent's tool gets says so on
 * its first line ("Chat <id>: failed (start_failed: <message>)").
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ChildAgentAdmission } from '../child-agent-admission.js';
import { formatChildAgentItem } from '../child-agent-result.js';
import { ChildAgentRunService, failureReason } from '../child-agent-runs.js';
import { waitForChildAgents } from '../child-agent-wait.js';
import { childFixture, type ChildFixture } from './child-agent-fixture.js';

let f: ChildFixture;
let logged: string[];
const wait = async (id: string) => (await waitForChildAgents({ sessions: f.reads(), queue: f.queue, refresh: (child) => f.app.refreshSession(child) },
  { chatIds: [id], timeoutMs: 0 })).items[0]!;
const service = (start: (childId: string) => Promise<void>) => new ChildAgentRunService({ sessions: f.reads(), log: (line) => logged.push(line),
  admission: new ChildAgentAdmission({ sessions: f.reads(), queue: f.queue }),
  launcher: { isRunning: () => false, start: ({ childId }) => start(childId) } });

beforeEach(async () => { f = await childFixture('child-agent-failure-'); logged = []; });
afterEach(async () => { await f.close(); });

describe('child-agent failure reasons', () => {
  it('logs a start that throws and tells the waiting parent why', async () => {
    const x = await f.child(f.rootId, 'x');
    await f.holdLease(x);
    await service(async () => { throw new Error('worker spawn refused'); }).request(x, 'task');
    expect(logged).toEqual([`[child-agent] start of ${x} failed: start_failed: worker spawn refused`]);
    expect(await f.queue.get(x)).toMatchObject({ state: 'released', release_reason: 'start_failed', release_detail: 'start_failed: worker spawn refused' });
    const item = await wait(x);
    expect(item).toMatchObject({ status: 'failed', reason: 'start_failed: worker spawn refused' });
    expect(formatChildAgentItem(item).split('\n')[0]).toBe(`Chat ${x}: failed (start_failed: worker spawn refused)`);
  });

  it('carries the reason of a run that ended badly without a conclusion', async () => {
    const x = await f.child(f.rootId, 'x');
    await f.holdLease(x);
    const runs = service(async () => undefined);
    await runs.request(x, 'task');
    await runs.ended(x, 'failed', failureReason('error', new Error(`Session ${x} not found`)));
    expect(await wait(x)).toMatchObject({ status: 'failed', reason: `error: Session ${x} not found` });
    // A new request starts clean.
    await runs.request(x, 'again');
    expect((await f.queue.get(x)).release_detail ?? null).toBeNull();
  });

  it('bounds the text and keeps a bare reason without a message', () => {
    expect(failureReason('start_failed', new Error('x'))).toBe('start_failed: x');
    expect(failureReason('start_failed', undefined)).toBe('start_failed');
    expect(failureReason('error', 'error')).toBe('error');
    expect(failureReason('run_failed', new Error('y'.repeat(900)))).toHaveLength(500);
  });
});
