import { HttpRouter } from '@mcp/shared/http/router.js';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FsSessionStore } from '@mcp/session-storage/fs-store/index.js';
import { ChatCollaborationStore, rootChatId } from '@mcp/session-storage/collaboration/store.js';
import { SessionNetwork } from '@mcp/code-agent/runtime/session-network.js';
import { mountSessionNetworkRoutes } from '../session-network-routes.js';

let directory: string, sessions: FsSessionStore, mailbox: ChatCollaborationStore, network: SessionNetwork, parentId: string, app: HttpRouter;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'session-network-routes-'));
  await mkdir(join(directory, 'project'));
  const project = { id: 1, name: 'Project', root_path: join(directory, 'project') };
  sessions = FsSessionStore.fromRoots({ dataDir: join(directory, 'data'), projectRootResolver: {
    resolveProjectRoot: () => project.root_path, listProjectRoots: () => [{ project_id: 1, root_path: project.root_path }],
  } });
  mailbox = new ChatCollaborationStore(join(directory, 'data')); await mailbox.init();
  network = new SessionNetwork({ sessions, mailbox, project: () => project, validateModel: (_provider, model) => { if (model !== 'model') throw new Error('Unavailable model'); } });
  const parent = await sessions.createSession({ project_id: 1, title: 'Coordinator', provider: 'provider', model: 'model' });
  parentId = parent.id; await mailbox.registerRoot(parent.id, parent.title); await network.settings(parentId, { enabled: true });
  app = new HttpRouter();
  mountSessionNetworkRoutes(app, { sessionStore: sessions, db: { listProjectsForGlobalPicker: () => [project] } } as never, network, Promise.resolve());
});
afterEach(async () => { await sessions.close(); await rm(directory, { recursive: true, force: true }); });
const request = (path: string, body: unknown, method = 'POST') => app.request(`/api/coder/sessions/${parentId}/collaboration/${path}`, {
  method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

it('validates every member and capacity before creating or starting any participant', async () => {
  const invalid = await request('team', { requestId: 'invalid', members: [{ title: 'Good', role: 'Review', start: true }, { title: 'Bad', role: 'Research', model: 'missing' }] });
  expect(invalid.status).toBe(400); expect(await sessions.listSessions(1)).toHaveLength(1); expect(await mailbox.pending()).toHaveLength(0);
  await network.settings(parentId, { maxSessions: 2 });
  const overQuota = await request('team', { requestId: 'quota', members: [{ title: 'One', role: 'Review' }, { title: 'Two', role: 'Research' }] });
  expect(overQuota.status).toBe(400); expect(await sessions.listSessions(1)).toHaveLength(1);
});

it('creates the full team before dispatch, preserves active state and retries without duplicate tasks', async () => {
  await mailbox.register({ ...(await mailbox.participant(rootChatId(parentId)))!, state: 'running' });
  expect((await request('settings', { role: 'Coordinate' }, 'PUT')).status).toBe(200);
  expect((await mailbox.participant(rootChatId(parentId)))?.state).toBe('running');
  await mailbox.stopSession(parentId);
  expect((await request('settings', { enabled: true }, 'PUT')).status).toBe(200);
  expect((await mailbox.participant(rootChatId(parentId)))?.state).toBe('idle');
  const originalSend = mailbox.send.bind(mailbox);
  const send = vi.spyOn(mailbox, 'send').mockImplementation(async input => {
    expect(await sessions.listSessions(1)).toHaveLength(4);
    expect(await mailbox.peers(input.to)).toHaveLength(3);
    return originalSend(input);
  });
  const payload = { requestId: 'team', members: ['One', 'Two', 'Three'].map(title => ({ title, role: 'Research', start: true })) };
  const first = await request('team', payload); expect(first.status).toBe(200);
  const created = (await first.json()).created;
  const retry = await request('team', payload); expect(retry.status).toBe(200);
  expect((await retry.json()).created).toEqual(created);
  expect(await mailbox.pending()).toHaveLength(3);
  send.mockRestore();
});
