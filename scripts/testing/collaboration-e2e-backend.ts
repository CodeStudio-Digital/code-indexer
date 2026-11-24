/** Local acceptance server: real filesystem sessions/routes, no provider execution. */
import { HttpRouter } from '@mcp/shared/http/router.js';
import { listenHttp } from '@mcp/shared/http/node-server.js';
import { mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { FsSessionStore } from '@mcp/session-storage/fs-store/index.js';
import { ChatCollaborationStore } from '@mcp/session-storage/collaboration/store.js';
import { mountChatCollaborationRoutes } from '../../apps/http-api/server/routes/coder/chat-collaboration.js';
import { CodeIndexDB } from '@mcp/store/db.js';
import { asSessionId } from '@mcp/session-storage';
import { CompanySessionFiles } from '@mcp/company/services/CompanySessionFiles.js';
import { OperationalSessionFiles } from '../../apps/http-api/server/operational-session-files.js';
import { runShutdownTasks } from '../../apps/http-api/server/shutdown-tasks.js';

if (!process.env.CODESTUDIO_E2E_DATA_DIR) throw new Error('An isolated CODESTUDIO_E2E_DATA_DIR is required');
const dataDir = resolve(process.env.CODESTUDIO_E2E_DATA_DIR);
process.env.MCP_INDEX_DB = join(dataDir, 'test.db');
const db = new CodeIndexDB(process.env.MCP_INDEX_DB);
const projectRoot = join(dataDir, 'project');
await mkdir(projectRoot, { recursive: true });
const project = db.getProjectByName('Fixture') ?? db.createProject('Fixture', projectRoot);
const sessions = FsSessionStore.fromRoots({ dataDir, projectRootResolver: {
  resolveProjectRoot: () => project.root_path,
  listProjectRoots: () => [{ project_id: 1, root_path: project.root_path }],
} });
const mailbox = new ChatCollaborationStore(dataDir);
await mailbox.init();
const app = new HttpRouter();
app.get('/__fixture/health', c => c.json({ ok: true }));
app.post('/__fixture/network', async c => {
  const create = (title: string) => sessions.createSession({ project_id: 1, title, provider: 'fixture', model: 'fixture' });
  const parent = await create('Coordenador'), peer = await create('Revisão de API');
  await mailbox.registerRoot(parent.id, parent.title); await mailbox.registerRoot(peer.id, peer.title);
  return c.json({ sessionId: parent.id, peerId: peer.id });
});
app.post('/__fixture/company', async c => {
  const files = new OperationalSessionFiles({
    repository: sessions.repository, catalog: sessions.catalog, locator: sessions.locator,
    projects: { getProject: () => project },
  });
  const team = async (name: string, roles: string[]) => {
    const company = await files.createCompanySession({ name, project_ids: [project.id] });
    const records = new CompanySessionFiles({ sessionStore: sessions, companySessionId: company.id });
    const members = [];
    for (const role of ['master', ...roles]) {
      // Old installations used the Company container as parent for every member.
      const chat = await sessions.createSession({ project_id: project.id, title: name + ' ' + role,
        provider: 'fixture', model: 'fixture', parent_session_id: asSessionId(company.id),
        metadata: { company_session_id: company.id, company_role: role } });
      if (role === 'master') await records.setMasterSessionId(chat.id);
      await records.createAgentRun({ role, coder_session_id: chat.id, project_ids: [project.id],
        provider: 'fixture', model: 'fixture', status: role === 'qa' ? 'interrupted' : 'idle' });
      members.push(chat.id);
    }
    return members;
  };
  const primary = await team('Animação', ['unity', 'qa']);
  const other = await team('Outra', ['editor']);
  const ordinary = await sessions.createSession({ project_id: project.id, title: 'Chat comum', provider: 'fixture', model: 'fixture' });
  return c.json({ primary, other, ordinary: ordinary.id, sessions: await sessions.listSessions(project.id) });
});
app.get('/api/coder/providers', c => c.json({ providers: [{ id: 'fixture', name: 'Fixture', models: [{ id: 'fixture', name: 'Fixture' }] }] }));
mountChatCollaborationRoutes(app, {
  sessionStore: sessions,
  db,
  providerStore: { getProvider: () => ({ enabled: true }), listModels: () => [{ model_id: 'fixture' }] },
} as never, {
  // Automatic admission is intentionally impossible even if a test submits work.
  findPendingInteraction: async () => ({ kind: 'fixture-no-provider' }),
} as never);
const server = listenHttp({ fetch: app.fetch, hostname: '127.0.0.1', port: Number(process.env.CODESTUDIO_E2E_API_PORT ?? 7349) });
const shutdown = async () => { await runShutdownTasks(); await sessions.close(); db.close(); server.close(); };
process.once('SIGTERM', () => void shutdown()); process.once('SIGINT', () => void shutdown());
const reportReady = () => console.log(JSON.stringify({ ready: true, pid: process.pid, port: server.address() }));
if (server.listening) reportReady();
else server.once('listening', reportReady);
