import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createAppStudio,
  getAppTeamConfig,
  getAppStudioSession,
  isAppStudioUuid,
  runAppAction,
  updateAppTeamConfig,
  type AppStudioSessionDetail,
} from '../app-studio-api.js';
import { appStudioEventsUrl, latestAppStudioEventSeq } from '../useAppStudioSession.js';

const APP_ID = '00000000-0000-0000-0000-000000000001';
const COMPANY_ID = '00000000-0000-0000-0000-000000000002';
const MASTER_ID = '00000000-0000-0000-0000-000000000003';
const MASTER_RUN_ID = '00000000-0000-0000-0000-000000000004';

function detail(): AppStudioSessionDetail {
  return {
    session: {
      id: APP_ID,
      seq: 1,
      project_id: 104,
      company_session_id: COMPANY_ID,
      name: 'Lontras',
      app_slug: 'lontras',
      stack_profile_id: 'cf-fullstack-v1',
      created_at: '2026-07-17T00:00:00.000Z',
      updated_at: '2026-07-17T00:00:00.000Z',
    },
    project: { id: 104, name: 'Lontras', root_path: 'C:/apps/lontras' },
    builder_port: 50376,
    stage: 'planning',
    plan_revision: null,
    plan_history: [],
    work_items: [],
    decisions: [],
    deployment: null,
    evidence_current: false,
    team: null,
    master_session_id: MASTER_ID,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('App Studio v6 API client', () => {
  it('accepts only UUID session identifiers and builds SSE replay cursors from seq', () => {
    const expected = detail();
    expected.recent_events = [
      { id: '00000000-0000-0000-0000-000000000011', seq: 11, kind: 'work.status', created_at: '2026-07-17T00:00:01.000Z' },
      { id: '00000000-0000-0000-0000-000000000012', seq: 12, kind: 'work.status', created_at: '2026-07-17T00:00:02.000Z' },
    ];

    expect(isAppStudioUuid(APP_ID)).toBe(true);
    expect(isAppStudioUuid('1')).toBe(false);
    expect(latestAppStudioEventSeq(expected)).toBe(12);
    expect(appStudioEventsUrl(APP_ID, 12)).toBe(`/api/app-studio/apps/${APP_ID}/events?after=12`);
  });

  it('sends execution mode independently from provider-native reasoning effort', async () => {
    const created = {
      project: { id: 104, name: 'Lontras', root_path: 'C:/apps/lontras' },
      app_session: detail().session,
      master_session_id: MASTER_ID,
      company_session_id: COMPANY_ID,
      team: {
        runtime_kind: 'app_studio', state: 'ready', company_session_id: COMPANY_ID,
        company_status: 'idle', master_session_id: MASTER_ID, master_agent_run_id: MASTER_RUN_ID,
      },
    };
    const fetchMock = vi.fn(async () => new Response(
      `event: done\ndata: ${JSON.stringify(created)}\n\n`,
      { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
    ));
    vi.stubGlobal('fetch', fetchMock);

    await expect(createAppStudio({
      name: 'Lontras',
      provider: 'openai',
      model: 'gpt-5',
      execution_mode: 'ultra',
      reasoning_effort: 'high',
    })).resolves.toEqual(created);
    expect(fetchMock).toHaveBeenCalledWith('/api/app-studio/apps', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({
        name: 'Lontras',
        provider: 'openai',
        model: 'gpt-5',
        execution_mode: 'ultra',
        reasoning_effort: 'high',
      }),
    }));
  });

  it('awaits the fetch promise before unwrapping an App detail response', async () => {
    const expected = detail();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(expected), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })));

    await expect(getAppStudioSession(APP_ID)).resolves.toEqual(expected);
  });

  it('awaits action responses that use the same central unwrap path', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(runAppAction(APP_ID, 'pause')).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledWith(`/api/app-studio/apps/${APP_ID}/actions`, expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ action: 'pause' }),
    }));
  });

  it('posts the explicit manual dispatch action used by the orchestration board', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(runAppAction(APP_ID, 'dispatch_ready_work')).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledWith(`/api/app-studio/apps/${APP_ID}/actions`, expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ action: 'dispatch_ready_work' }),
    }));
  });

  it('renders structured API failures instead of undefined fields', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      error: { message: 'The current plan is blocked.' },
    }), {
      status: 409,
      statusText: 'Conflict',
      headers: { 'Content-Type': 'application/json' },
    })));

    await expect(getAppStudioSession(APP_ID)).rejects.toThrow('409: The current plan is blocked.');
  });

  it('reads and updates team config through the App-owned facade', async () => {
    const team = {
      company_session_id: COMPANY_ID,
      status: 'idle' as const,
      operational_rules: 'Always verify.',
      roles: [{
        role: 'master', enabled: true, provider: 'openai', model: 'gpt-5', tier: 'navigate' as const,
        fallbackModels: [{ provider: 'anthropic', model: 'claude' }],
      }],
    };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(team), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(getAppTeamConfig(APP_ID)).resolves.toEqual(team);
    await expect(updateAppTeamConfig(APP_ID, { operational_rules: 'Always verify.' })).resolves.toEqual(team);
    expect(fetchMock).toHaveBeenNthCalledWith(1, `/api/app-studio/apps/${APP_ID}/team/config`);
    expect(fetchMock).toHaveBeenNthCalledWith(2, `/api/app-studio/apps/${APP_ID}/team/config`, expect.objectContaining({
      method: 'PATCH',
      body: JSON.stringify({ operational_rules: 'Always verify.' }),
    }));
  });
});
