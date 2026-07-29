import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import type { ServerDeps } from '../../../deps.js';

const uuid = (value: number): string =>
  `${value.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`;
const APP_ID = uuid(7);
const COMPANY_ID = uuid(90);
const OTHER_APP_ID = uuid(99);
const APP_COMMANDS_URL = `/api/app-studio/apps/${APP_ID}/team/commands`;

const lifecycle = vi.hoisted(() => ({
  abortCompanyRuntime: vi.fn(() => ({ ok: true as const })),
}));

vi.mock('../../company/runtime-lifecycle.js', () => ({
  abortCompanyRuntime: lifecycle.abortCompanyRuntime,
}));

import { mountAppStudioTeamRuntimeRoutes } from '../team-runtime.js';

function makeDeps(input: {
  appId?: string;
  companyId?: string | null;
  runtimeKind?: 'company' | 'app_studio';
  reverseAppId?: string | null;
} = {}): ServerDeps {
  const appId = input.appId ?? APP_ID;
  const companyId = input.companyId === undefined ? COMPANY_ID : input.companyId;
  const reverseAppId = input.reverseAppId === undefined ? appId : input.reverseAppId;
  return {
    appStudioStore: {
      getSession: vi.fn((id: string) => id === appId ? {
        id: appId,
        company_session_id: companyId,
      } : null),
      getSessionByCompanySessionId: vi.fn((id: string) => (
        id === companyId && reverseAppId != null ? { id: reverseAppId } : null
      )),
    },
    operationalSessionFiles: {
      getCompanySession: vi.fn((id: string) => id === companyId ? {
        id,
        runtime_kind: input.runtimeKind ?? 'app_studio',
      } : null),
    },
  } as unknown as ServerDeps;
}

function mountWithCompanyFakes(deps = makeDeps()) {
  const app = new Hono();
  const calls: Array<{ action: string; companyId: string; body: unknown; lastEventId: string | null }> = [];
  const lifecycleActions = ['start', 'resume', 'message', 'answer', 'plan-response', 'wake-master'] as const;

  for (const action of lifecycleActions) {
    app.post(`/api/company/sessions/:id/${action}`, async (c) => {
      const body = await c.req.json().catch(() => null) as unknown;
      calls.push({
        action,
        companyId: c.req.param('id'),
        body,
        lastEventId: c.req.header('Last-Event-ID') ?? null,
      });
      return c.json({ ok: true, action, company_session_id: c.req.param('id') });
    });
  }

  app.get('/api/company/sessions/:id', (c) => c.json({
    session: {
      id: c.req.param('id'),
      runtime_kind: 'app_studio',
      // A global default mini may exist, but the persisted runs prove which
      // configured/effective models actually executed.
      config_json: JSON.stringify({
        allowed_models: [{ provider: 'openai-chatgpt', model: 'gpt-5.4-mini', is_default: true }],
      }),
    },
    agentRuns: [
      {
        id: uuid(1),
        role: 'master',
        configured_provider: 'openai-chatgpt',
        configured_model: 'gpt-5.6-terra',
        provider: 'openai-chatgpt',
        model: 'gpt-5.6-terra',
        dispatch_source: 'app_studio',
        fallback_reason: null,
      },
      {
        id: uuid(2),
        role: 'backend',
        configured_provider: 'openai-chatgpt',
        configured_model: 'gpt-5.6-sol',
        provider: 'openai-chatgpt',
        model: 'gpt-5.6-sol',
        dispatch_source: 'app_studio',
        fallback_reason: null,
      },
      {
        id: uuid(3),
        role: 'frontend',
        configured_provider: 'openai-chatgpt',
        configured_model: 'gpt-5.6-luna',
        provider: 'openai-chatgpt',
        model: 'gpt-5.6-luna',
        dispatch_source: 'app_studio',
        fallback_reason: null,
      },
    ],
  }));

  app.get('/api/company/sessions/:id/state-snapshot', (c) => c.json({
    company_session_id: c.req.param('id'),
    liveOrchestrator: true,
    masterAlive: true,
  }));

  app.get('/api/company/sessions/:id/attach', (c) => {
    calls.push({
      action: 'attach',
      companyId: c.req.param('id'),
      body: null,
      lastEventId: c.req.header('Last-Event-ID') ?? null,
    });
    return new Response(
      `event: bus_info\ndata: {"bus_id":"bus-app-90"}\n\nid: 12\nevent: agent_status\ndata: {"agentRunId":"${uuid(2)}","status":"working","configuredModel":"gpt-5.6-sol","effectiveModel":"gpt-5.6-sol"}\n\n`,
      { headers: { 'content-type': 'text/event-stream; charset=UTF-8' } },
    );
  });

  mountAppStudioTeamRuntimeRoutes(app, deps);
  return { app, calls };
}

describe('App Studio team runtime facade', () => {
  it('authorizes through the App link and exposes configured/effective run provenance', async () => {
    const { app } = mountWithCompanyFakes();
    const response = await app.request(`${APP_COMMANDS_URL}/state`);
    const body = await response.json() as {
      session: { id: string; config_json: string };
      agentRuns: Array<{ role: string; configured_model: string; model: string; dispatch_source: string }>;
    };

    expect(response.status).toBe(200);
    expect(body.session.id).toBe(COMPANY_ID);
    expect(JSON.parse(body.session.config_json)).toMatchObject({
      allowed_models: [{ model: 'gpt-5.4-mini', is_default: true }],
    });
    expect(body.agentRuns).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'master', configured_model: 'gpt-5.6-terra', model: 'gpt-5.6-terra', dispatch_source: 'app_studio' }),
      expect.objectContaining({ role: 'backend', configured_model: 'gpt-5.6-sol', model: 'gpt-5.6-sol', dispatch_source: 'app_studio' }),
      expect.objectContaining({ role: 'frontend', configured_model: 'gpt-5.6-luna', model: 'gpt-5.6-luna', dispatch_source: 'app_studio' }),
    ]));
    expect(body.agentRuns.some((run) => run.model === 'gpt-5.4-mini')).toBe(false);
  });

  it.each([
    ['start', { user_message: 'build it', client_msg_id: 'start-1' }],
    ['resume', { message: 'continue', client_msg_id: 'resume-1' }],
    ['message', { message: 'change direction', interject: true }],
    ['answer', { answer: 'Postgres', prompt_id: uuid(10) }],
    ['plan-response', { approved: true, prompt_id: uuid(11) }],
    ['wake-master', null],
  ] as const)('delegates %s to the linked Company lifecycle', async (action, payload) => {
    const { app, calls } = mountWithCompanyFakes();
    const response = await app.request(`${APP_COMMANDS_URL}/${action}`, {
      method: 'POST',
      headers: payload ? { 'content-type': 'application/json' } : undefined,
      body: payload ? JSON.stringify(payload) : undefined,
    });

    expect(response.status).toBe(200);
    expect(calls).toContainEqual(expect.objectContaining({
      action,
      companyId: COMPANY_ID,
      body: payload,
    }));
  });

  it('preserves the real multiplexed SSE body and Last-Event-ID replay cursor', async () => {
    const { app, calls } = mountWithCompanyFakes();
    const response = await app.request(`${APP_COMMANDS_URL}/attach`, {
      headers: { 'Last-Event-ID': '8' },
    });
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(body).toContain('event: bus_info');
    expect(body).toContain('id: 12');
    expect(body).toContain('"configuredModel":"gpt-5.6-sol"');
    expect(calls).toContainEqual(expect.objectContaining({
      action: 'attach',
      companyId: COMPANY_ID,
      lastEventId: '8',
    }));
  });

  it.each([
    ['company', APP_ID, 'APP_TEAM_LINK_INVALID'],
    ['app_studio', OTHER_APP_ID, 'APP_TEAM_LINK_INVALID'],
  ] as const)('rejects a non-App or mismatched reverse link', async (runtimeKind, reverseAppId, code) => {
    const { app } = mountWithCompanyFakes(makeDeps({ runtimeKind, reverseAppId }));
    const response = await app.request(`${APP_COMMANDS_URL}/state`);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code });
  });

  it('aborts only after resolving the linked team through the App facade', async () => {
    lifecycle.abortCompanyRuntime.mockClear();
    const { app } = mountWithCompanyFakes();
    const response = await app.request(`${APP_COMMANDS_URL}/abort`, { method: 'POST' });

    expect(response.status).toBe(200);
    expect(lifecycle.abortCompanyRuntime).toHaveBeenCalledWith(COMPANY_ID);
  });
});
