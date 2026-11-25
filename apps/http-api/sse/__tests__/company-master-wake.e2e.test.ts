import { expect, test, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createServer, type ServerResponse } from 'node:http';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { CodeIndexDB } from '@mcp/store/db.js';
import { ProviderStore } from '@mcp/store/provider-store.js';
import { FsSessionStore } from '@mcp/session-storage/fs-store/fs-session-store.js';
import { CollaborationFiles } from '@mcp/session-storage/collaboration/files.js';
import { CollaborationRevisions } from '@mcp/session-storage/collaboration/revisions.js';
import { CompanySessionFiles } from '@mcp/company/services/CompanySessionFiles.js';
import { CompanyWorkspaceCoordinator } from '@mcp/company/services/workspace-coordinator.js';
import { OperationalSessionFiles } from '../../server/operational-session-files.js';
import { WorkerOrchestratorPool } from '../WorkerOrchestratorPool.js';

interface RequestBody {
  model: string;
  messages: Array<{role: string; content: unknown}>;
  tools: Array<{function: {name: string}}>;
}
interface Request { body: RequestBody; response: ServerResponse }
function respond(request: Request, value: string | { name: string; args: object }) {
  const tool = typeof value !== 'string';
  const delta = tool ? { tool_calls: [{ index: 0, id: randomUUID(), type: 'function',
    function: { name: value.name, arguments: JSON.stringify(value.args) } }] } : { content: value };
  request.response.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const [part, reason] of [[{ role: 'assistant', ...delta }, null], [{}, tool ? 'tool_calls' : 'stop']]) {
    request.response.write('data: ' + JSON.stringify({ id: 'fixture', choices: [{ index: 0, delta: part, finish_reason: reason }] }) + '\n\n');
  }
  request.response.end('data: [DONE]\n\n');
}

test('Master dispatches cards from a legacy blocked workspace and wakes in the same chat on specialist events', async () => {
  const root = await mkdtemp(join(tmpdir(), 'company-master-wake-'));
  const dbPath = join(root, 'index.db');
  vi.stubEnv('MCP_INDEX_DB', dbPath);
  vi.stubEnv('MCP_DATA_DIR', root);
  vi.stubEnv('MCP_RUNTIME_COORDINATION_DIR', join(root, 'runtime'));
  vi.stubEnv('MCP_COMPANY_SCHEDULER', '0');
  const projectRoot = join(root, 'project');
  await mkdir(projectRoot);
  const db = new CodeIndexDB(dbPath);
  const project = db.createProject('Wake fixture', projectRoot);
  const requests: Request[] = [];
  const server = createServer(async (request, response) => {
    if (!request.url?.endsWith('/chat/completions')) { response.writeHead(404).end(); return; }
    let body = '';
    for await (const chunk of request) body += chunk;
    requests.push({ body: JSON.parse(body), response });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const providers = new ProviderStore(db.raw());
  providers.upsertProvider({ id: 'fixture', name: 'Local fixture', kind: 'openai', base_url: 'http://127.0.0.1:' + port + '/v1',
    api_key: 'synthetic', enabled: true, use_for_coder: true });
  const roles = ['qa', 'reviewer'];
  providers.replaceModelsFromSource('fixture', 'manual', ['master', ...roles].map(role => ({
    model_id: role, name: role, context_window: 128000,
  })));
  const store = FsSessionStore.fromRoots({ dataDir: root, projectRootResolver: {
    resolveProjectRoot: id => id === project.id ? projectRoot : null,
    listProjectRoots: () => [{ project_id: project.id, root_path: projectRoot }],
  } });
  const files = new OperationalSessionFiles({ repository: store.repository, catalog: store.catalog, locator: store.locator,
    projects: { getProject: id => db.getProject(id) ?? null } });
  const company = await files.createCompanySession({ name: 'Master wake fixture', project_ids: [project.id],
    config_json: JSON.stringify({ autonomy: { scheduler: false }, master_provider: 'fixture', master_model: 'master',
      role_assignments: roles.map(role => ({ role, tier: 'navigate', provider: 'fixture', model: role, enabled: true, projectIds: [project.id] })) }) });
  const records = new CompanySessionFiles({ companySessionId: company.id, sessionStore: store });
  const journal = new CollaborationFiles(join(records.location.bundle_path, 'company', 'workspace-coordination'));
  await journal.ensure('ownership');
  await new CollaborationRevisions(journal).change('ownership', 'workspace', { holders: [] }, () => ({ holders: [{
    token: randomUUID(), sessionId: randomUUID(), agentRunId: randomUUID(), toolUseId: 'old-wait', toolName: 'wait_for_subordinates',
    phase: 'uncertain', startedAt: 1,
  }] }));
  const workspace = new CompanyWorkspaceCoordinator(records.location.bundle_path);
  expect(await workspace.owners()).toEqual([]);
  // A real file effect now needs review. Board tools, decisions and both
  // delegates must remain usable while that exact effect stays fenced.
  await workspace.run({ sessionId: company.id, agentRunId: randomUUID(), toolUseId: 'prior-edit', toolName: 'edit_file' },
    async () => 'unknown', () => true);
  const [priorEdit] = await workspace.owners();
  const pool = new WorkerOrchestratorPool({ workerFile: resolve('apps/http-api/workers/_dev-bootstrap.mjs'),
    workerDevTsEntry: resolve('apps/http-api/workers/company-worker.ts'), workerExecArgv: [], dbPath,
    resolveCompanySessionRuntimeContext: async sessionId => ({ sessionId, bundlePath: records.location.bundle_path, projectRoot, projectId: project.id }),
    onChatCreated: async (_owner, chat, scope) => { await store.repository.refreshSessionProjectionAsync(store.locator.locate(scope, chat)); },
  });
  const poll = { timeout: 25_000, interval: 50 };
  const byRole = (role: string) => requests.filter(r => r.body.model === role);
  async function next(role: string, index: number) {
    await expect.poll(() => byRole(role).length, { ...poll, message: role + ' request ' + index }).toBeGreaterThan(index);
    return byRole(role)[index];
  }
  try {
    const { orchestrator, bus } = await pool.getOrSpawn(company.id);
    const start = await orchestrator.startMaster({ userMessage: 'Dispatch two fixture checks, then review their results.', provider: 'fixture', model: 'master' });
    const first = await next('master', 0);
    const catalog = first.body.tools.map(t => t.function.name);
    expect(catalog).toContain('spawn_subordinate_agent');
    for (const name of ['wait_for_subordinates', 'list_containers', 'read_container_logs']) expect(catalog).not.toContain(name);
    respond(first, { name: 'kanban_create_card', args: { cards: roles.map(role => ({ owner: role, title: 'Check ' + role, column: 'todo' })) } });
    const second = await next('master', 1);
    const cards = records.listKanbanCardsSync();
    expect(cards).toHaveLength(2);
    respond(second, { name: 'post_to_board', args: { kind: 'decision', content: 'Dispatch approved for fixture checks.' } });
    for (const [i, role] of roles.entries()) {
      const card = cards.find(item => item.title === 'Check ' + role)!;
      respond(await next('master', i + 2), { name: 'spawn_subordinate_agent', args: {
        role, task: 'Inspect the synthetic fixture assigned to ' + role, kanban_card_id: card.id,
      } });
    }
    const qa = await next('qa', 0);
    const reviewer = await next('reviewer', 0);
    respond(await next('master', 4), 'The specialists are working.');
    await expect.poll(() => orchestrator.getMasterStatus(), poll).toMatchObject({ alive: false });
    // The first specialist finishes while the Master has no live runner.
    respond(qa, 'QA fixture passed: QA-101.');
    const resumed = await next('master', 5);
    expect(JSON.stringify(resumed.body.messages)).toContain('QA-101');
    respond(resumed, { name: 'ask_user', args: { question: 'Which fixture report format?' } });
    const pending = await expectPendingQuestion();
    // A specialist asks a decision while the Master is waiting on its human.
    respond(reviewer, { name: 'ask_master', args: { question: 'Should I include metric R-202?' } });
    await expect.poll(() => records.listAgentRunsSync().find(r => r.role === 'reviewer')?.status, poll).toBe('waiting_question');
    expect((await records.getPendingMasterPrompt('question'))?.id).toBe(pending.id);
    expect(byRole('master')).toHaveLength(6);
    await expect(orchestrator.respondToMasterQuestion('Use the compact format.', pending.id)).resolves.toMatchObject({ id: pending.id });
    const choice = await next('master', 6);
    const messages = JSON.stringify(choice.body.messages);
    expect(messages).toContain('Use the compact format.');
    expect(messages).toContain('R-202');
    const reviewerRun = records.listAgentRunsSync().find(run => run.role === 'reviewer')!;
    respond(choice, { name: 'answer_subordinate_question', args: { agent_run_id: reviewerRun.id, answer: 'Include R-202.' } });
    const reviewAnswer = await next('reviewer', 1);
    expect(JSON.stringify(reviewAnswer.body.messages)).toContain('Include R-202.');
    respond(reviewAnswer, 'Review fixture passed: REV-202.');
    // If an event arrives mid-turn the runner drains its queue at the next boundary.
    let turn = 7;
    let final = await next('master', turn++);
    if (!JSON.stringify(final.body.messages).includes('REV-202')) {
      respond(final, 'Received.');
      final = await next('master', turn++);
    }
    expect(JSON.stringify(final.body.messages)).toContain('REV-202');
    respond(final, { name: 'post_to_board', args: { kind: 'deliverable', content: 'QA-101 and REV-202 verified.' } });
    respond(await next('master', turn++), 'Reviewed both checks.');
    await expect.poll(() => records.listBoardEntriesSync().map(e => e.content), poll).toContain('QA-101 and REV-202 verified.');
    const runs = records.listAgentRunsSync();
    expect(runs.filter(r => r.role === 'master').map(r => r.coder_session_id)).toEqual([start.masterSessionId]);
    for (const role of roles) {
      const run = runs.filter(r => r.role === role);
      expect(run).toHaveLength(1);
      const assigned = records.getKanbanCardFullSync(cards.find(card => card.title === 'Check ' + role)!.id)!.agents;
      expect(assigned.filter(a => !a.unassigned_at).map(a => a.agent_run_id)).toEqual([run[0].id]);
    }
    await expect.poll(() => orchestrator.getMasterStatus(), poll).toMatchObject({ alive: false });
    expect(await workspace.owners()).toEqual([priorEdit]);
    expect(byRole('master')).toHaveLength(turn);
    expect(bus.buffer.filter(event => event.event === 'agent_event' && JSON.stringify(event.data).includes('WORKSPACE_OUTCOME_PENDING'))).toEqual([]);
    async function expectPendingQuestion() {
      await expect.poll(() => records.getPendingMasterPrompt('question'), poll).toBeTruthy();
      return (await records.getPendingMasterPrompt('question'))!;
    }
  } finally {
    server.closeAllConnections();
    await pool.dispose();
    await new Promise<void>(done => server.close(() => done()));
    await store.close();
    db.close();
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}, 160_000);
