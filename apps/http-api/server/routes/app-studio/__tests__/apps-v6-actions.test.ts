import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyAppPlan, type AppPlanV1 } from '@mcp/app-studio/plan/types.js';
import { auditAppPlan } from '@mcp/app-studio/plan/fitness.js';
import type { ServerDeps } from '../../../deps.js';

const uuid = (value: number): string =>
  `${value.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`;
const APP_ID = uuid(1);
const COMPANY_ID = uuid(2);
const REVISION_ID = uuid(3);
const WORK_ITEM_ID = uuid(4);
const PALETTE_DECISION_ID = uuid(44);
const PRIORITY_DECISION_ID = uuid(45);
const REFUSED_DECISION_ID = uuid(46);
const UNKNOWN_DECISION_ID = uuid(47);
const APP_URL = `/api/app-studio/apps/${APP_ID}`;
const ACTIONS_URL = `${APP_URL}/actions`;

const mocks = vi.hoisted(() => ({
  dispatchReadyAppWork: vi.fn(),
  getAppTeamSession: vi.fn(),
  getOrSpawnCompanyOrchestrator: vi.fn(),
  sendMessageToMaster: vi.fn(),
  evictCompanyOrchestrator: vi.fn(async () => undefined),
}));

vi.mock('@mcp/company/tools/app-studio/company-dispatch.js', () => ({
  dispatchReadyAppWork: mocks.dispatchReadyAppWork,
}));
vi.mock('@mcp/api-handlers/app-studio/app-team-session.js', () => ({
  getAppTeamSession: mocks.getAppTeamSession,
}));
vi.mock('../../../../sse/companyOrchestrator.js', () => ({
  getOrSpawnCompanyOrchestrator: mocks.getOrSpawnCompanyOrchestrator,
  getCompanyOrchestrator: vi.fn(() => null),
  evictCompanyOrchestrator: mocks.evictCompanyOrchestrator,
}));

import { mountAppStudioV6AppRoutes } from '../apps-v6.js';

function readyPlan(): AppPlanV1 {
  const plan = emptyAppPlan('pt-BR');
  plan.intent.summary = 'Catálogo navegável de produtos para compradores recorrentes.';
  plan.intent.audience = 'Compradores';
  plan.intent.goals.push({ id: 'goal:catalog', text: 'Consultar produtos.' });
  plan.scope.capabilities.push({
    id: 'cap:catalog',
    name: 'Catálogo',
    description: 'Consultar produtos disponíveis.',
    selected: true,
    critical: false,
    quality_attributes: [],
    source_ids: ['goal:catalog'],
  });
  plan.scope.acceptance.push({
    id: 'accept:catalog',
    text: 'Lista produtos disponíveis.',
    capability_ids: ['cap:catalog'],
  });
  plan.experience.screens.push({
    id: 'screen:catalog',
    name: 'Catálogo',
    purpose: 'Consultar produtos.',
    route: '/',
    primary: true,
    protected: false,
    capability_ids: ['cap:catalog'],
    states: [],
  });
  plan.engineering.components.push({
    id: 'component:spa',
    kind: 'spa',
    name: 'Web',
    responsibility: 'Exibir o catálogo.',
    consumer_ids: ['screen:catalog'],
    source_ids: ['cap:catalog'],
  });
  plan.delivery.tests.push({
    id: 'test:catalog',
    title: 'Catálogo visível',
    kind: 'browser',
    source_ids: ['cap:catalog'],
    expected: 'Produtos aparecem na tela.',
  });
  plan.delivery.slices.push({
    id: 'slice:catalog',
    name: 'Catálogo navegável',
    capability_ids: ['cap:catalog'],
    screen_ids: ['screen:catalog'],
    entity_ids: [],
    test_ids: ['test:catalog'],
    depends_on: [],
  });
  return plan;
}

function testApp(options: {
  companySessionId?: string | null;
  workItems?: Array<Record<string, unknown>>;
  workRuns?: Array<Record<string, unknown>>;
  decisions?: Array<Record<string, unknown>>;
  events?: Array<Record<string, unknown>>;
} = {}) {
  const plan = readyPlan();
  const fitness = auditAppPlan(plan);
  const session = {
    id: APP_ID,
    seq: 1,
    project_id: 12,
    company_session_id: options.companySessionId ?? null,
    name: 'Catalog',
    app_slug: 'catalog',
    stack_profile_id: 'cf-fullstack-v1',
    created_at: '2026-07-19T00:00:00.000Z',
    updated_at: '2026-07-19T00:00:00.000Z',
  };
  const revision = {
    id: REVISION_ID,
    seq: 1,
    app_session_id: APP_ID,
    revision_number: 2,
    status: 'draft',
    plan_json: JSON.stringify(plan),
    fitness_json: JSON.stringify(fitness),
    created_by: 'app_orchestrator',
    created_at: '2026-07-19 00:00:00',
    updated_at: '2026-07-19 00:00:00',
    approved_at: null as string | null,
  };
  const workItems = [...(options.workItems ?? [])];
  const workRuns = [...(options.workRuns ?? [])];
  const decisions = [...(options.decisions ?? [])];
  const events = [...(options.events ?? [])];
  const store = {
    getSession: vi.fn(() => session),
    getLatestPlanRevision: vi.fn(() => revision),
    approvePlanRevision: vi.fn(() => {
      revision.status = 'approved';
      revision.approved_at = '2026-07-19 00:01:00';
      return revision;
    }),
    listWorkItems: vi.fn(() => workItems),
    listWorkItemRuns: vi.fn(() => workRuns),
    upsertWorkItems: vi.fn((items: Array<Record<string, unknown>>) => {
      workItems.push(...items);
      return items;
    }),
    refreshReadyWorkItems: vi.fn(() => workItems),
    listDecisions: vi.fn(() => decisions),
    resolveDecision: vi.fn((_sessionId: string, decisionId: string, answer: string) => {
      const decision = decisions.find((item) => item.id === decisionId) ?? {
        id: decisionId,
        app_session_id: APP_ID,
        question: 'Qual direção devemos seguir?',
        status: 'open',
        answer: null,
      };
      decision.status = 'resolved';
      decision.answer = answer;
      return decision;
    }),
    getLatestDeployment: vi.fn(() => null),
    listPlanRevisions: vi.fn(() => [revision]),
    listEvents: vi.fn((_id: string, afterSeq = 0) => events
      .filter((event) => Number(event.seq) > afterSeq)
      .slice(0, 250)),
    appendEvent: vi.fn(async () => undefined),
  };
  const deps = {
    appStudioStore: store,
    db: {
      getProject: vi.fn(() => ({
        id: 12,
        name: 'Catalog',
        root_path: null,
        builder_json: null,
      })),
    },
  } as unknown as ServerDeps;
  const app = new Hono();
  mountAppStudioV6AppRoutes(app, deps);
  return { app, deps, plan, revision, session, store, workItems };
}

describe('App Studio v6 orchestration actions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getAppTeamSession.mockResolvedValue(null);
    mocks.sendMessageToMaster.mockResolvedValue({ ok: true });
    mocks.getOrSpawnCompanyOrchestrator.mockResolvedValue({
      orchestrator: { sendMessageToMaster: mocks.sendMessageToMaster },
      bus: {},
    });
  });

  it('preserves work already materialized for the approved revision', async () => {
    const existing = {
      app_session_id: APP_ID,
      id: WORK_ITEM_ID,
      seq: 1,
      source_id: 'custom:catalog',
      plan_revision_id: REVISION_ID,
      title: 'Catálogo vertical',
      kind: 'implement',
      owner_role: 'fullstack',
      status: 'backlog',
      depends_on_json: '[]',
      source_ids_json: '[]',
      acceptance_json: '[]',
      evidence_json: '[]',
      file_scope_json: '[]',
    };
    const { app, store } = testApp({ companySessionId: COMPANY_ID, workItems: [existing] });

    const response = await app.request(ACTIONS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'approve_plan_and_build' }),
    });

    expect(response.status).toBe(200);
    expect(store.approvePlanRevision).toHaveBeenCalledWith(APP_ID, REVISION_ID);
    expect(store.upsertWorkItems).not.toHaveBeenCalled();
    expect(store.refreshReadyWorkItems).toHaveBeenCalledWith(APP_ID);
    expect(mocks.getOrSpawnCompanyOrchestrator).toHaveBeenCalledWith(COMPANY_ID);
    expect(mocks.sendMessageToMaster).not.toHaveBeenCalled();
  });

  it('materializes a fallback graph only when the revision has no work', async () => {
    const { app, store } = testApp({ companySessionId: COMPANY_ID });

    const response = await app.request(ACTIONS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'approve_plan_and_build' }),
    });

    expect(response.status).toBe(200);
    expect(store.upsertWorkItems).toHaveBeenCalledOnce();
    expect(store.upsertWorkItems).toHaveBeenCalledWith([
      expect.objectContaining({ id: 'slice:slice:catalog:implement', plan_revision_id: REVISION_ID }),
      expect.objectContaining({ id: 'slice:slice:catalog:verify', plan_revision_id: REVISION_ID }),
    ]);
    expect(mocks.getOrSpawnCompanyOrchestrator).toHaveBeenCalledWith(COMPANY_ID);
    expect(mocks.sendMessageToMaster).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({ scheduler_resumed: true });
  });

  it('keeps approval successful when the scheduler runtime cannot resume', async () => {
    mocks.getOrSpawnCompanyOrchestrator.mockRejectedValueOnce(new Error('worker unavailable'));
    const { app, store } = testApp({ companySessionId: COMPANY_ID });

    const response = await app.request(ACTIONS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'approve_plan_and_build' }),
    });
    const body = await response.json() as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(store.approvePlanRevision).toHaveBeenCalledWith(APP_ID, REVISION_ID);
    expect(body).toMatchObject({
      scheduler_resumed: false,
      warning: 'Plan approved, but the App scheduler could not be resumed.',
    });
    expect(store.appendEvent).toHaveBeenCalledWith(
      APP_ID,
      'build.scheduler_resume_failed',
      'app',
      APP_ID,
      JSON.stringify({ error: 'worker unavailable' }),
    );
  });

  it('dispatches an explicit manual wave without messaging the Master', async () => {
    const orchestrator = { marker: 'host' };
    const results = [{ workItemId: 'custom:catalog', role: 'fullstack', outcome: 'spawned' }];
    mocks.getOrSpawnCompanyOrchestrator.mockResolvedValue({ orchestrator, bus: {} });
    mocks.dispatchReadyAppWork.mockResolvedValue(results);
    const { app, session, store } = testApp({ companySessionId: COMPANY_ID });

    const response = await app.request(ACTIONS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'dispatch_ready_work' }),
    });

    expect(response.status).toBe(200);
    expect(mocks.getOrSpawnCompanyOrchestrator).toHaveBeenCalledWith(COMPANY_ID);
    expect(mocks.dispatchReadyAppWork).toHaveBeenCalledWith({
      store,
      session,
      host: orchestrator,
      source: 'manual',
      maxItems: 2,
    });
    await expect(response.json()).resolves.toMatchObject({ dispatch_results: results });
  });

  it('fences the worker when a specialist spawn acknowledgement is lost', async () => {
    const orchestrator = { marker: 'host' };
    const results = [{
      workItemId: 'custom:catalog',
      role: 'fullstack',
      outcome: 'blocked',
      code: 'OUTCOME_UNKNOWN',
    }];
    mocks.getOrSpawnCompanyOrchestrator.mockResolvedValue({ orchestrator, bus: {} });
    mocks.dispatchReadyAppWork.mockResolvedValue(results);
    const { app } = testApp({ companySessionId: COMPANY_ID });

    const response = await app.request(ACTIONS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'dispatch_ready_work' }),
    });

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      code: 'OUTCOME_UNKNOWN',
      dispatch_results: results,
    });
    expect(mocks.evictCompanyOrchestrator).toHaveBeenCalledWith(COMPANY_ID);
  });

  it('resumes Master coordination after durably resolving a decision', async () => {
    const orchestrator = { sendMessageToMaster: vi.fn(async () => ({ ok: true })) };
    mocks.getOrSpawnCompanyOrchestrator.mockResolvedValue({ orchestrator, bus: {} });
    const { app, store } = testApp({
      companySessionId: COMPANY_ID,
      decisions: [{
        id: PALETTE_DECISION_ID,
        question: 'Qual paleta devemos usar?',
        status: 'open',
        answer: null,
      }],
    });

    const response = await app.request(ACTIONS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'answer_decision',
        decision_id: PALETTE_DECISION_ID,
        answer: 'Azul e branco',
      }),
    });
    const body = await response.json() as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(store.resolveDecision).toHaveBeenCalledWith(APP_ID, PALETTE_DECISION_ID, 'Azul e branco');
    expect(orchestrator.sendMessageToMaster).toHaveBeenCalledWith(expect.stringMatching(
      /Qual paleta devemos usar\?[\s\S]*Azul e branco[\s\S]*Não despache trabalho[\s\S]*scheduler/,
    ));
    expect(body).toMatchObject({
      coordination_resumed: true,
      decision: { id: PALETTE_DECISION_ID, status: 'resolved', answer: 'Azul e branco' },
    });
  });

  it('preserves a resolved decision when Master coordination cannot resume', async () => {
    mocks.getOrSpawnCompanyOrchestrator.mockRejectedValueOnce(new Error('worker offline'));
    const { app, store } = testApp({
      companySessionId: COMPANY_ID,
      decisions: [{
        id: PRIORITY_DECISION_ID,
        question: 'Qual fluxo priorizar?',
        status: 'open',
        answer: null,
      }],
    });

    const response = await app.request(ACTIONS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'answer_decision',
        decision_id: PRIORITY_DECISION_ID,
        answer: 'Catálogo primeiro',
      }),
    });
    const body = await response.json() as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(store.resolveDecision).toHaveBeenCalledWith(
      APP_ID,
      PRIORITY_DECISION_ID,
      'Catálogo primeiro',
    );
    expect(body).toMatchObject({
      coordination_resumed: false,
      warning: 'Decision saved, but App coordination could not be resumed.',
      decision: { id: PRIORITY_DECISION_ID, status: 'resolved', answer: 'Catálogo primeiro' },
    });
    expect(store.appendEvent).toHaveBeenCalledWith(
      APP_ID,
      'decision.coordination_failed',
      'decision',
      PRIORITY_DECISION_ID,
      JSON.stringify({ error: 'worker offline' }),
    );
  });

  it('does not claim coordination resumed when the Master refuses a resolved decision', async () => {
    const orchestrator = {
      sendMessageToMaster: vi.fn(async () => ({
        ok: false,
        pending: 'interactive_wait' as const,
      })),
    };
    mocks.getOrSpawnCompanyOrchestrator.mockResolvedValue({ orchestrator, bus: {} });
    const { app, store } = testApp({
      companySessionId: COMPANY_ID,
      decisions: [{
        id: REFUSED_DECISION_ID,
        question: 'Qual fluxo?',
        status: 'open',
        answer: null,
      }],
    });

    const response = await app.request(ACTIONS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'answer_decision',
        decision_id: REFUSED_DECISION_ID,
        answer: 'Catálogo',
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      coordination_resumed: false,
      decision: { id: REFUSED_DECISION_ID, status: 'resolved' },
    });
    expect(store.appendEvent).toHaveBeenCalledWith(
      APP_ID,
      'decision.coordination_failed',
      'decision',
      REFUSED_DECISION_ID,
      JSON.stringify({
        error: 'Master is waiting for another interactive answer',
        code: 'INTERACTION_PENDING',
      }),
    );
  });

  it('reports unknown decision-delivery outcome without replaying after a closed worker port', async () => {
    const orchestrator = {
      sendMessageToMaster: vi.fn(async () => {
        throw { code: 'port_closed', message: 'worker exited' };
      }),
    };
    mocks.getOrSpawnCompanyOrchestrator.mockResolvedValue({ orchestrator, bus: {} });
    const { app } = testApp({
      companySessionId: COMPANY_ID,
      decisions: [{
        id: UNKNOWN_DECISION_ID,
        question: 'Qual fluxo?',
        status: 'open',
        answer: null,
      }],
    });

    const response = await app.request(ACTIONS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'answer_decision',
        decision_id: UNKNOWN_DECISION_ID,
        answer: 'Catálogo',
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      coordination_resumed: false,
      code: 'OUTCOME_UNKNOWN',
    });
    expect(mocks.evictCompanyOrchestrator).toHaveBeenCalledWith(COMPANY_ID);
    expect(orchestrator.sendMessageToMaster).toHaveBeenCalledOnce();
  });

  it('resumes an approved build under the scheduler without waking the Master', async () => {
    const orchestrator = { sendMessageToMaster: vi.fn(async () => ({ ok: true })) };
    mocks.getOrSpawnCompanyOrchestrator.mockResolvedValue({ orchestrator, bus: {} });
    const { app, revision, store } = testApp({ companySessionId: COMPANY_ID });
    revision.status = 'approved';

    const response = await app.request(ACTIONS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'resume' }),
    });

    expect(response.status).toBe(200);
    expect(mocks.getOrSpawnCompanyOrchestrator).toHaveBeenCalledWith(COMPANY_ID);
    expect(orchestrator.sendMessageToMaster).not.toHaveBeenCalled();
    expect(store.appendEvent).toHaveBeenCalledWith(
      APP_ID,
      'build.resumed',
      'app',
      APP_ID,
      JSON.stringify({ mode: 'scheduler' }),
    );
  });

  it('wakes the Master on resume only when planning coordination remains', async () => {
    const orchestrator = { sendMessageToMaster: vi.fn(async () => ({ ok: true })) };
    mocks.getOrSpawnCompanyOrchestrator.mockResolvedValue({ orchestrator, bus: {} });
    const { app, store } = testApp({ companySessionId: COMPANY_ID });

    const response = await app.request(ACTIONS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'resume' }),
    });

    expect(response.status).toBe(200);
    expect(orchestrator.sendMessageToMaster).toHaveBeenCalledOnce();
    expect(store.appendEvent).toHaveBeenCalledWith(
      APP_ID,
      'build.resumed',
      'app',
      APP_ID,
      JSON.stringify({ mode: 'master_coordination' }),
    );
  });

  it('does not append build.resumed when the Master refuses coordination', async () => {
    const orchestrator = {
      sendMessageToMaster: vi.fn(async () => ({
        ok: false,
        pending: 'interactive_wait' as const,
      })),
    };
    mocks.getOrSpawnCompanyOrchestrator.mockResolvedValue({ orchestrator, bus: {} });
    const { app, store } = testApp({ companySessionId: COMPANY_ID });

    const response = await app.request(ACTIONS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'resume' }),
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: 'INTERACTION_PENDING' });
    expect(store.appendEvent).not.toHaveBeenCalledWith(
      APP_ID,
      'build.resumed',
      'app',
      APP_ID,
      expect.anything(),
    );
  });

  it('returns the latest 50 durable events with parsed payloads on app detail', async () => {
    const events = Array.from({ length: 55 }, (_, index) => ({
      id: uuid(1_000 + index),
      seq: index + 1,
      app_session_id: APP_ID,
      kind: index === 54 ? 'agents.specialist_dispatched' : 'work.status',
      entity_type: 'work',
      entity_id: WORK_ITEM_ID,
      payload_json: JSON.stringify({ sequence: index + 1 }),
      idempotency_key: null,
      created_at: `2026-07-19 00:00:${String(index).padStart(2, '0')}`,
    }));
    const { app } = testApp({ events });

    const response = await app.request(APP_URL);
    const body = await response.json() as { recent_events: Array<Record<string, unknown>> };

    expect(response.status).toBe(200);
    expect(body.recent_events).toHaveLength(50);
    expect(body.recent_events[0]).toMatchObject({
      id: uuid(1_005),
      seq: 6,
      payload: { sequence: 6 },
    });
    expect(body.recent_events[49]).toMatchObject({
      id: uuid(1_054),
      seq: 55,
      event_type: 'agents.specialist_dispatched',
      payload: { sequence: 55 },
    });
  });

  it('embeds recent and active attempts in each work item', async () => {
    const workItem = {
      app_session_id: APP_ID,
      id: WORK_ITEM_ID,
      seq: 1,
      source_id: 'custom:catalog',
      plan_revision_id: REVISION_ID,
      title: 'Catálogo vertical',
      kind: 'implement',
      owner_role: 'fullstack',
      status: 'running',
      depends_on_json: '[]',
      source_ids_json: '[]',
      acceptance_json: '[]',
      evidence_json: '[]',
      file_scope_json: '[]',
    };
    const currentRunId = uuid(12);
    const previousRunId = uuid(11);
    const currentAgentRunId = uuid(81);
    const previousAgentRunId = uuid(80);
    const workRuns = [
      {
        id: currentRunId,
        work_item_id: WORK_ITEM_ID,
        attempt: 2,
        status: 'running',
        company_agent_run_id: currentAgentRunId,
      },
      {
        id: previousRunId,
        work_item_id: WORK_ITEM_ID,
        attempt: 1,
        status: 'error',
        company_agent_run_id: previousAgentRunId,
      },
    ];
    const { app } = testApp({ workItems: [workItem], workRuns });

    const response = await app.request(APP_URL);
    const body = await response.json() as { work_items: Array<Record<string, unknown>> };

    expect(response.status).toBe(200);
    expect(body.work_items[0]).toMatchObject({
      latest_attempt: { id: currentRunId, attempt: 2, status: 'running' },
      active_attempt: {
        id: currentRunId,
        attempt: 2,
        status: 'running',
        company_agent_run_id: currentAgentRunId,
      },
      attempts: [
        { id: currentRunId, attempt: 2, status: 'running' },
        { id: previousRunId, attempt: 1, status: 'error' },
      ],
    });
  });

  it('ignores cancelled cards when deriving progress for the current revision', async () => {
    const base = {
      app_session_id: APP_ID,
      plan_revision_id: REVISION_ID,
      kind: 'implement',
      owner_role: 'fullstack',
      depends_on_json: '[]',
      source_ids_json: '[]',
      acceptance_json: '[]',
      evidence_json: '[]',
      file_scope_json: '[]',
    };
    const { app, revision } = testApp({ workItems: [
      { ...base, id: 'catalog:done', title: 'Catálogo', status: 'done' },
      { ...base, id: 'duplicate:cancelled', title: 'Duplicado', status: 'cancelled' },
    ] });
    revision.status = 'approved';

    const response = await app.request(APP_URL);
    const body = await response.json() as { stage: string };

    expect(response.status).toBe(200);
    expect(body.stage).toBe('reviewing');
  });
});
