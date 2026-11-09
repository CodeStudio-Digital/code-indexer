/** Local acceptance server: real filesystem sessions/routes, no provider execution. */
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { FsSessionStore } from '@mcp/session-storage/fs-store/index.js';
import { ChatCollaborationStore } from '@mcp/session-storage/collaboration/store.js';
import { mountChatCollaborationRoutes } from '../../apps/http-api/server/routes/coder/chat-collaboration.js';
import { runShutdownTasks } from '../../apps/http-api/server/shutdown-tasks.js';

if (!process.env.CODESTUDIO_E2E_DATA_DIR) throw new Error('An isolated CODESTUDIO_E2E_DATA_DIR is required');
const dataDir = resolve(process.env.CODESTUDIO_E2E_DATA_DIR);
const project = { id: 1, name: 'Fixture', root_path: join(dataDir, 'project') };
await mkdir(project.root_path, { recursive: true });
const sessions = FsSessionStore.fromRoots({ dataDir, projectRootResolver: {
  resolveProjectRoot: () => project.root_path,
  listProjectRoots: () => [{ project_id: 1, root_path: project.root_path }],
} });
const mailbox = new ChatCollaborationStore(dataDir);
await mailbox.init();
const app = new Hono();
app.get('/__fixture/health', c => c.json({ ok: true }));
app.post('/__fixture/network', async c => {
  const create = (title: string) => sessions.createSession({ project_id: 1, title, provider: 'fixture', model: 'fixture' });
  const parent = await create('Coordenador'), peer = await create('Revisão de API');
  await mailbox.registerRoot(parent.id, parent.title); await mailbox.registerRoot(peer.id, peer.title);
  return c.json({ sessionId: parent.id, peerId: peer.id });
});
app.get('/api/coder/providers', c => c.json({ providers: [{ id: 'fixture', name: 'Fixture', models: [{ id: 'fixture', name: 'Fixture' }] }] }));
mountChatCollaborationRoutes(app, {
  sessionStore: sessions,
  db: { getProject: () => project, listProjectsForGlobalPicker: () => [project] },
  providerStore: { getProvider: () => ({ enabled: true }), listModels: () => [{ model_id: 'fixture' }] },
} as never, {
  // Automatic admission is intentionally impossible even if a test submits work.
  findPendingInteraction: async () => ({ kind: 'fixture-no-provider' }),
} as never);
const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: Number(process.env.CODESTUDIO_E2E_API_PORT ?? 7349) });
const shutdown = async () => { await runShutdownTasks(); await sessions.close(); server.close(); };
process.once('SIGTERM', () => void shutdown()); process.once('SIGINT', () => void shutdown());
console.log(JSON.stringify({ ready: true, pid: process.pid, port: server.address() }));
