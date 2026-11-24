import { test, expect, vi } from 'vitest';
import { createServer, type ServerResponse } from 'node:http';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { Worker } from 'node:worker_threads';
import { CodeIndexDB } from '@mcp/store/db.js';
import { ProviderStore } from '@mcp/store/provider-store.js';
import { SessionWriter } from '@mcp/session-storage/session-writer.js';
import { FsSessionStore } from '@mcp/session-storage/fs-store/fs-session-store.js';
import { asSessionId } from '@mcp/session-storage';
import { CompanySessionFiles } from '@mcp/company/services/CompanySessionFiles.js';
import { OperationalSessionFiles } from '../../server/operational-session-files.js';
import { recentNotificationRuntimeEvents } from '../notification-event-bus.js';
import { WorkerOrchestratorPool } from '../WorkerOrchestratorPool.js';
import { interruptCompanyWorker } from '../company-worker-exit.js';
import { companyTeamForChat } from '../../server/routes/coder/company-chat-team.js';

test('slow provider, worker exit and same-card recovery through the Company worker and filesystem', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codestudio-company-recovery-'));
  const dbPath = join(root, 'index.db');
  vi.stubEnv('MCP_INDEX_DB', dbPath);
  vi.stubEnv('MCP_DATA_DIR', root);
  vi.stubEnv('MCP_RUNTIME_COORDINATION_DIR', join(root, 'coordination'));
  vi.stubEnv('MCP_SUPERVISOR_ENABLED', '1');
  vi.stubEnv('MCP_COMPANY_SCHEDULER', '0');
  const db = new CodeIndexDB(dbPath);
  const projectRoot = join(root, 'project');
  await mkdir(projectRoot);
  const project = db.createProject('Synthetic Company', projectRoot);
  const server = createServer();
  const requests: ServerResponse[] = [];
  const reply = (response: ServerResponse) => {
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const chunk = (delta: object, finish_reason: string | null) => JSON.stringify({ id: 'fixture', choices: [{ index: 0, delta, finish_reason }] });
    response.end(`data: ${chunk({ role: 'assistant', content: 'OK' }, null)}\n\ndata: ${chunk({}, 'stop')}\n\ndata: [DONE]\n\n`);
  };
  server.on('request', (req, response) => {
    req.resume();
    if (!req.url?.endsWith('/chat/completions')) { response.writeHead(404).end(); return; }
    requests.push(response);
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const port = (server.address() as { port: number }).port;
  const providers = new ProviderStore(db.raw());
  providers.upsertProvider({ id: 'fixture', name: 'Local fixture', kind: 'openai', base_url: `http://127.0.0.1:${port}/v1`, api_key: 'synthetic', enabled: true, use_for_coder: true });
  providers.replaceModelsFromSource('fixture', 'manual', [{ model_id: 'fixture-chat', name: 'Local fixture', context_window: 128000 }]);
  const store = FsSessionStore.fromRoots({ dataDir: root, projectRootResolver: {
    resolveProjectRoot: id => id === project.id ? projectRoot : null,
    listProjectRoots: () => [{ project_id: project.id, root_path: projectRoot }],
  } });
  const files = new OperationalSessionFiles({ repository: store.repository, catalog: store.catalog, locator: store.locator, projects: { getProject: id => db.getProject(id) ?? null } });
  const config = { autonomy: { scheduler: false }, master_provider: 'fixture', master_model: 'fixture-chat', role_assignments: ['qa', 'unreal'].map(role => ({
    role, tier: 'navigate', provider: 'fixture', model: 'fixture-chat', enabled: true, projectIds: [project.id],
  })) };
  const company = await files.createCompanySession({ name: 'Synthetic Company', project_ids: [project.id], config_json: JSON.stringify(config) });
  const records = new CompanySessionFiles({ companySessionId: company.id, sessionStore: store });
  const master = await store.createSession({ parent_session_id: asSessionId(company.id), project_id: project.id, title: 'Synthetic master', provider: 'fixture', model: 'fixture-chat', metadata: { company_session_id: company.id, company_role: 'master' } });
  await records.setMasterSessionId(master.id);
  await records.updateSessionStatus('running');
  await records.createAgentRun({ role: 'master', coder_session_id: master.id, model: 'fixture-chat', provider: 'fixture', project_ids: [project.id], status: 'idle' });
  const card = records.createKanbanCardSync({ title: 'Verify fixture', column: 'todo', createdBy: 'master', control: { owner: 'qa', visualQA: false, projectId: project.id, acceptance: [] } });
  const pool = new WorkerOrchestratorPool({
    workerFile: resolve('apps/http-api/workers/_dev-bootstrap.mjs'), workerDevTsEntry: resolve('apps/http-api/workers/company-worker.ts'), workerExecArgv: [], dbPath, ttlMs: 1000,
    resolveCompanySessionRuntimeContext: async sessionId => ({ sessionId, bundlePath: records.location.bundle_path, projectRoot, projectId: project.id }),
    onWorkerExit: (...args) => interruptCompanyWorker(store, ...args),
    onChatCreated: async (owner, chat, scope) => {
      expect(owner).toBe(company.id);
      await store.repository.refreshSessionProjectionAsync(store.locator.locate(scope, chat));
    },
  });
  const poll = { timeout: 35_000, interval: 100 };
  try {
    const [first, concurrent] = await Promise.all([pool.getOrSpawn(company.id), pool.getOrSpawn(company.id)]);
    expect(concurrent.bus).toBe(first.bus);
    const spec = { kanbanCardId: card.id, task: 'Reply with OK. Use no tools.', projectId: project.id };
    await expect(first.orchestrator.spawnSubordinate({ ...spec, role: 'unreal' })).rejects.toThrow();
    const assigned = await first.orchestrator.spawnSubordinate({ ...spec, role: 'qa' });
    await expect.poll(() => requests.length, poll).toBe(1);
    await expect.poll(() => recentNotificationRuntimeEvents(0).some(e => e.sessionId === assigned.coderSessionId && e.event === 'chat_session_created'), poll).toBe(true);
    await delay(66_000); // Cross the old 60s heartbeat deadline with no HTTP headers or deltas.
    expect(requests[0].destroyed).toBe(false);
    expect(await pool.supervisorRpc(company.id, 'getStatus')).toMatchObject({ isRunning: true, stuckCount: 0, byState: { AWAITING_PROVIDER: 1 } });
    expect(records.getAgentRunSync(assigned.agentRunId)?.status).toBe('running');
    expect((await first.orchestrator.spawnSubordinate({ ...spec, role: 'qa' })).agentRunId).toBe(assigned.agentRunId);
    expect((await first.orchestrator.dispatchCard(card.id, 'unreal')).ok).toBe(false);
    reply(requests[0]);
    await expect.poll(() => records.getAgentRunSync(assigned.agentRunId)?.status, poll).toBe('waiting');
    await first.orchestrator.resumeSubordinate(assigned.agentRunId, 'Confirm OK again without tools.');
    await expect.poll(() => requests.length, poll).toBe(2);
    // Terminate the actual thread without invoking a graceful lifecycle command.
    const entry = (pool as unknown as { entries: Map<string, { host: { worker: Worker } }> }).entries.get(company.id)!;
    const childLocation = (await store.getSessionLocation(assigned.coderSessionId))!;
    const lease = JSON.parse(await readFile(join(childLocation.bundle_path, 'events', 'writer.lease'), 'utf8'));
    expect(lease.owner_id).toMatch(/^company-worker:/);
    // Also exercise the crash window during a Company bundle write.
    const parentWriter = await SessionWriter.open({ bundlePath: records.location.bundle_path, sessionId: asSessionId(company.id), ownerId: lease.owner_id });
    try {
      await entry.host.worker.terminate();
      await expect.poll(() => first.bus.endReason?.data, poll).toMatchObject({ reason: 'worker_crashed' });
    } finally { await parentWriter.close(); }
    expect(records.getAgentRunSync(assigned.agentRunId)?.status).toBe('interrupted');
    expect(records.getSession().status).toBe('interrupted');
    expect(first.bus.buffer.some(e => e.event === 'agent_status' && (e.data as { status: string }).status === 'interrupted')).toBe(true);
    expect((await store.refreshSession(assigned.coderSessionId))?.status).toBe('interrupted');
    const restarted = await pool.getOrSpawn(company.id);
    const resumed = await restarted.orchestrator.spawnSubordinate({ ...spec, role: 'qa' });
    expect(resumed).toMatchObject({ agentRunId: assigned.agentRunId, coderSessionId: assigned.coderSessionId });
    await expect.poll(() => requests.length, poll).toBe(3);
    reply(requests[2]);
    await expect.poll(() => records.getAgentRunSync(assigned.agentRunId)?.status, poll).toBe('waiting');
    expect(records.listAgentRunsSync().filter(run => run.role !== 'master')).toHaveLength(1);
    expect(records.getKanbanCardFullSync(card.id)?.agents.filter(a => !a.unassigned_at).map(a => a.agent_run_id)).toEqual([assigned.agentRunId]);
    const second = records.createKanbanCardSync({ title: 'Inspect fixture', column: 'todo', createdBy: 'master', control: { owner: 'unreal', visualQA: false, projectId: project.id, acceptance: [] } });
    await expect(restarted.orchestrator.spawnSubordinate({ ...spec, role: 'qa', kanbanCardId: second.id })).rejects.toThrow();
    const unreal = await restarted.orchestrator.spawnSubordinate({ ...spec, role: 'unreal', kanbanCardId: second.id });
    await expect.poll(() => requests.length, poll).toBe(4);
    reply(requests[3]);
    await expect.poll(() => records.getAgentRunSync(unreal.agentRunId)?.status, poll).toBe('waiting');
    expect(unreal.coderSessionId).not.toBe(assigned.coderSessionId);
    expect(records.getKanbanCardFullSync(second.id)?.agents.filter(a => !a.unassigned_at)).toMatchObject([{ role: 'unreal', agent_run_id: unreal.agentRunId }]);
    expect(records.listAgentRunsSync().filter(run => run.role !== 'master')).toHaveLength(2);
    const graph = await companyTeamForChat(store, master);
    expect(graph?.masterId).toBe(master.id);
    expect(graph?.members.map(m => m.id)).toContain(assigned.coderSessionId);
  } finally {
    server.closeAllConnections();
    await pool.dispose();
    await new Promise<void>(done => server.close(() => done()));
    await store.close();
    db.close();
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
  }
}, 200_000);
