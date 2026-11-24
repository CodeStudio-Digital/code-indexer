import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { SessionLocator } from '@mcp/session-storage';
import { FsSessionStore } from '@mcp/session-storage/fs-store/fs-session-store.js';
import { HttpRouter } from '@mcp/shared/http/router.js';
import { CoderRunner } from '@mcp/code-agent/core/runner.js';
import { ToolRegistry } from '@mcp/code-agent/core/registry.js';
import { askUser } from '@mcp/code-agent/tools/interaction.js';
import { submitPlan } from '@mcp/code-agent/tools/plan.js';
import { CompanySessionFiles } from '@mcp/company/services/CompanySessionFiles.js';
import { MasterHumanInteraction } from '@mcp/company/services/master-human-interaction.js';
import { AgentSupervisor } from '@mcp/company/services/supervisor/AgentSupervisor.js';
import { setGlobalAgentSupervisor } from '@mcp/company/services/supervisor/global.js';
import { wireSupervisorToRunner } from '@mcp/company/services/supervisor/wire-runner-events.js';
import { CompanyEventBus } from '@mcp/company/services/CompanyEventBus.js';
import { SubordinateCompletionBus } from '@mcp/company/services/subordinate/completion-events.js';
import type { RunCoderHandle } from '@mcp/code-agent/index/types.js';
import type { MasterPrompt } from '@mcp/company-contracts';
import { mountCompanyStreamRoutes } from '../stream.js';
import type { ServerDeps } from '../../../deps.js';
import { OperationalSessionFiles } from '../../../operational-session-files.js';

const mocks = vi.hoisted(() => ({ currentWorker: vi.fn() }));
vi.mock('../../../../sse/companyOrchestrator.js', async (original) => ({
  ...await original<typeof import('../../../../sse/companyOrchestrator.js')>(),
  getCompanyOrchestrator: mocks.currentWorker,
}));

let directory: string;
afterEach(async () => {
  setGlobalAgentSupervisor(null);
  mocks.currentWorker.mockReset();
  if (directory) await rm(directory, { recursive: true, force: true });
});

it.each([
  { kind: 'question', reply: { answer: 'Analisar primeiro a pasta de testes.' } },
  { kind: 'question', reply: { answer: 'review' } },
  { kind: 'plan', reply: { approved: false, feedback: 'Inclua o teste.' } },
])('delivers $reply through the company route and unblocks the actual $kind tool', async ({ kind, reply }) => {
  directory = await mkdtemp(join(tmpdir(), 'master-prompt-roundtrip-'));
  const locator = new SessionLocator({
    dataDir: directory, projectRootResolver: { listProjectRoots: () => [], resolveProjectRoot: () => null },
  });
  const store = new FsSessionStore({ locator });
  const { session } = await store.repository.createSession({ kind: 'company', scope: { kind: 'global' } });
  const other = await store.repository.createSession({ kind: 'company', scope: { kind: 'global' } });
  await store.refresh();
  const files = new CompanySessionFiles({ companySessionId: session.id, sessionStore: store });
  const toolContext = { cwd: directory, projectName: 'synthetic' };
  const runner = new CoderRunner({
    registry: new ToolRegistry(), systemPrompt: 'test', toolContext,
    provider: { name: 'test', model: 'test', setModel: vi.fn(), async *chat() { yield { type: 'done' as const }; } },
  });
  const handle = { runner } as RunCoderHandle;
  const agentRunId = 'a0000000-0000-4000-8000-000000000001';
  const bus = { publish: vi.fn(), markEnded: vi.fn(), bus: {} };
  const board = { post: vi.fn(), read: () => [], lastMasterSeenSeq: 0, advanceMasterWatermark: vi.fn() };
  const status = { setStatus: vi.fn(), publishStatus: vi.fn() };
  const master = { handle, agentRunId, isAlive: true, endedWithError: null, notify: vi.fn(), setShouldContinue: vi.fn() };
  const interaction = new MasterHumanInteraction(bus as never, board, status, master,
    { companySessionId: files.companySessionId, companyFiles: files });
  interaction.wireMasterQuestion(handle);
  interaction.wireMasterPlan(handle);
  mocks.currentWorker.mockReturnValue(interaction);
  const supervisor = new AgentSupervisor({
    companySessionId: session.id, companyEventBus: new CompanyEventBus(), completionBus: new SubordinateCompletionBus(),
  });
  supervisor.registerMaster({ companySessionId: session.id, agentRunId });
  setGlobalAgentSupervisor(supervisor);
  const unwire = wireSupervisorToRunner(runner, agentRunId, 'master');
  const app = new HttpRouter();
  mountCompanyStreamRoutes(app, { sessionStore: store } as ServerDeps);
  const path = '/api/company/sessions/' + session.id;
  const tool = kind === 'question' ? askUser : submitPlan;
  runner.emit('turn_start', 1);
  runner.emit('tool_call_start', 'call-1', tool.name, {});
  const pending = tool.handler(kind === 'question' ? {
    question: 'Como seguimos?', options: [{ label: 'Revisar', value: 'review' }, { label: 'Continuar', value: 'next' }], allow_freeform: true,
  } : { plan: 'Revisar as dependências e executar os testes.' }, { ...toolContext, runner });
  try {
    await vi.waitFor(() => expect(bus.publish).toHaveBeenCalledWith('master_' + kind + '_posted', expect.anything()));
    const prompt = bus.publish.mock.calls[0][1].prompt as MasterPrompt;
    const receipt = path + '/master-prompts/' + prompt.id;
    expect((await (await app.request(receipt)).json()).prompt.status).toBe('pending');
    expect((await app.request('/api/company/sessions/' + other.session.id + '/master-prompts/' + prompt.id)).status).toBe(404);
    const state = () => supervisor.listRecords()[0].state;
    runner.emit('tool_call_start', 'parallel', 'read_file', {});
    runner.emit('tool_call_result', 'parallel', 'read_file', { content: 'ok' }, 100);
    await supervisor.tickOnce(Date.now() + 8 * 60_000);
    expect(state()).toBe('AWAITING_HUMAN');
    expect(status.publishStatus).toHaveBeenLastCalledWith(agentRunId, 'master', kind === 'question' ? 'waiting_question' : 'waiting_plan');
    expect(supervisor.listRecords()[0].incidentCount).toBe(0);

    const url = path + (kind === 'question' ? '/answer' : '/plan-response');
    const post = () => app.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt_id: prompt.id, ...reply }) });
    expect((await post()).status).toBe(200);
    const result = await pending;
    expect(result.content).toContain(reply.answer ?? reply.feedback);
    expect(state()).toBe('AWAITING_TOOL');
    runner.emit('tool_call_result', 'call-1', tool.name, result, 100);
    expect(state()).toBe('RUNNING_TURN');
    expect(master.setShouldContinue).toHaveBeenCalledWith(true);
    expect(status.publishStatus).toHaveBeenLastCalledWith(agentRunId, 'master', 'running');
    expect((await post()).status).toBe(409);
    expect(board.post).toHaveBeenCalledTimes(1);
    const saved = await app.request(receipt);
    expect(saved.headers.get('cache-control')).toBe('no-store');
    expect((await saved.json()).prompt).toMatchObject({ id: prompt.id, company_session_id: session.id, status: 'answered', ...reply });
    runner.emit('tool_call_start', 'after-reply', 'read_file', {});
    await supervisor.tickOnce(Date.now() + 8 * 60_000);
    expect(state()).toBe('STUCK_TOOL');
  } finally {
    unwire();
    runner.abort();
    await pending;
  }
});

it('includes the current question in the snapshot after fifty older prompts', async () => {
  directory = await mkdtemp(join(tmpdir(), 'master-prompt-snapshot-'));
  const locator = new SessionLocator({
    dataDir: directory, projectRootResolver: { listProjectRoots: () => [], resolveProjectRoot: () => null },
  });
  const store = new FsSessionStore({ locator });
  const { session } = await store.repository.createSession({ kind: 'company', scope: { kind: 'global' } });
  await store.refresh();
  const files = new CompanySessionFiles({ sessionStore: store, companySessionId: session.id });
  for (let i = 0; i < 50; i++) {
    await files.createMasterPrompt({ agent_run_id: null, kind: 'question', body: 'old ' + i });
  }
  await files.cancelPendingMasterPrompts();
  const latest = await files.createMasterPrompt({ agent_run_id: null, kind: 'question', body: 'current' });
  const sessions = new OperationalSessionFiles({ locator, repository: store.repository, catalog: store.catalog, projects: { getProject: () => null } });
  const snapshot = await sessions.getCompanySessionFull(session.id);
  expect(snapshot?.masterPrompts).toHaveLength(50);
  expect(snapshot?.masterPrompts.at(-1)).toMatchObject(latest);
});
