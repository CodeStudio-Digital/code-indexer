import { Hono } from 'hono';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FsSessionStore } from '@mcp/session-storage/fs-store/index.js';
import { ChatCollaborationStore } from '@mcp/session-storage/collaboration/store.js';
import { CollaborationFollowups } from '@mcp/session-storage/collaboration/followups.js';
import { SessionNetwork } from '@mcp/code-agent/runtime/session-network.js';
import { ChatScheduler } from '@mcp/code-agent/runtime/chat-scheduler.js';
import { mountUltraFollowupRoutes } from '../ultra-followups.js';

let directory: string, sessions: FsSessionStore, mailbox: ChatCollaborationStore, network: SessionNetwork, scheduler: ChatScheduler, id: string, app: Hono;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ultra-routes-')); await mkdir(join(directory, 'project'));
  const project = { id: 1, name: 'Project', root_path: join(directory, 'project') };
  sessions = FsSessionStore.fromRoots({ dataDir: join(directory, 'data'), projectRootResolver: {
    resolveProjectRoot: () => project.root_path, listProjectRoots: () => [{ project_id: 1, root_path: project.root_path }],
  } });
  mailbox = new ChatCollaborationStore(join(directory, 'data')); await mailbox.init();
  network = new SessionNetwork({ sessions, mailbox, project: () => project }); scheduler = new ChatScheduler(mailbox);
  const session = await sessions.createSession({ project_id: 1, title: 'Main', provider: 'fixture', model: 'fixture' });
  id = session.id; await mailbox.registerRoot(id, session.title); await network.settings(id, { enabled: true });
  app = new Hono(); mountUltraFollowupRoutes(app, network, scheduler, Promise.resolve());
});
afterEach(async () => { vi.restoreAllMocks(); await sessions.close(); await rm(directory, { recursive: true, force: true }); });
const request = (path: string, body: unknown, method = 'POST') => app.request(`/api/coder/sessions/${id}/collaboration/${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

it('recovers a proposal crash after creating the chat without creating a second chat or executing work', async () => {
  const proposal = await (await request('proposals', { title: 'Review API', prompt: 'Review the contract', rationale: 'Follow-up', context: 'workspace', sourceRevision: 'run1', requestId: 'proposal1' })).json();
  const original = CollaborationFollowups.prototype.change;
  let fail = true;
  vi.spyOn(CollaborationFollowups.prototype, 'change').mockImplementation(async function (this: CollaborationFollowups, ...args: Parameters<CollaborationFollowups['change']>) {
    const [kind, value, update, revision] = args;
    if (kind === 'proposals' && fail && (value as { state?: string }).state === 'claimed') { fail = false; throw new Error('injected crash after create'); }
    return original.call(this, kind, value, update, revision);
  });
  const body = { revision: proposal.revision, requestId: 'accept1', mode: 'new' };
  expect((await request(`proposals/${proposal.id}/accept`, body)).status).toBe(400);
  expect(await sessions.listSessions(1)).toHaveLength(2);
  const accepted = await request(`proposals/${proposal.id}/accept`, body); expect(accepted.status).toBe(200);
  expect((await accepted.json()).proposal.state).toBe('accepted');
  expect(await sessions.listSessions(1)).toHaveLength(2); expect(await mailbox.pending()).toHaveLength(0);
});
it('does not let a proposal bypass session authority', async () => {
  await network.settings(id, { enabled: false });
  const proposal = await (await request('proposals', { title: 'Review', prompt: 'Review', rationale: '', context: 'fresh', sourceRevision: 'run', requestId: 'p' })).json();
  expect((await request(`proposals/${proposal.id}/accept`, { revision: proposal.revision, requestId: 'claim', mode: 'new' })).status).toBe(400);
  expect(await sessions.listSessions(1)).toHaveLength(1);
});
it('requires a policy revision and retains the new setting without changing effort', async () => {
  expect((await request('policy', { expectedRevision: 0, maxParallel: 1 }, 'PATCH')).status).toBe(200);
  expect((await request('policy', { expectedRevision: 0, maxParallel: 2 }, 'PATCH')).status).toBe(409);
  const value = await (await app.request(`/api/coder/sessions/${id}/collaboration/policy`)).json();
  expect(value.settings.maxParallel).toBe(1); expect(value.revision).toBe(1);
  expect((await request('policy', { expectedRevision: 1, maxStarts: 8 }, 'PATCH')).status).toBe(200);
  const changed = await (await app.request(`/api/coder/sessions/${id}/collaboration/policy`)).json();
  expect(changed.settings).toEqual({ maxParallel: 1, maxStarts: 8 });
  expect(changed.budget.limits.maxStarts).toBe(8);
});

it('marks a prepared proposal started only when the admitted prompt matches', async () => {
  const records = new CollaborationFollowups(mailbox.files);
  const proposal = await records.propose({ sessionId: id, title: 'Review', prompt: 'Review contract', rationale: '', context: 'workspace', sourceRevision: 'run' }, 'p');
  await request(`proposals/${proposal.id}/accept`, { revision: proposal.revision, requestId: 'accept', mode: 'here' });
  await records.observeStarted(id, 'unrelated', 'Different task');
  expect((await records.get('proposals', proposal.id))?.state).toBe('accepted');
  await records.observeStarted(id, 'actual-run', 'Review contract');
  expect(await records.get('proposals', proposal.id)).toMatchObject({ state: 'started', startedRunId: 'actual-run' });
  await records.observeStarted(id, 'later-run', 'Review contract');
  expect(await records.get('proposals', proposal.id)).toMatchObject({ startedRunId: 'actual-run' });
});
it('separates schedule acceptance from start and cancels queued work on pause', async () => {
  let now = Date.now(); scheduler = new ChatScheduler(mailbox, () => now);
  const schedule = await scheduler.create(id, { kind: 'recurring', cron: '* * * * *', timezone: 'UTC', action: 'run', prompt: 'Check build', misfire: 'fire_once', overlap: 'coalesce', maxRuns: 3 }, 'timer', true);
  now = schedule.nextDueAt; await scheduler.tick();
  const occurrence = (await scheduler.records.list<import('@mcp/agent-runtime-contracts').ScheduledOccurrence>('occurrences', id))[0];
  expect(occurrence.state).toBe('accepted'); expect(occurrence.runId).toBeUndefined();
  const message = await mailbox.get(occurrence.messageId!); expect(await scheduler.canWake(message.id, message.references)).toBe(true);
  const latest = (await scheduler.records.get<import('@mcp/agent-runtime-contracts').ScheduledTrigger>('schedules', schedule.id))!;
  await scheduler.control(id, schedule.id, 'pause', latest.revision);
  expect(await scheduler.canWake(message.id, message.references)).toBe(false);
  expect((await mailbox.get(message.id)).status).toBe('cancelled');
});
