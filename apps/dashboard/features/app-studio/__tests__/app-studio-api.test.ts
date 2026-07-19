import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getAppTeamConfig,
  getAppStudioSession,
  runAppAction,
  updateAppTeamConfig,
  type AppStudioSessionDetail,
} from '../app-studio-api.js';

function detail(): AppStudioSessionDetail {
  return {
    session: {
      id: 1,
      project_id: 104,
      company_session_id: 106,
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
    master_session_id: 1265,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('App Studio v6 API client', () => {
  it('awaits the fetch promise before unwrapping an App detail response', async () => {
    const expected = detail();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(expected), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })));

    await expect(getAppStudioSession(1)).resolves.toEqual(expected);
  });

  it('awaits action responses that use the same central unwrap path', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(runAppAction(1, 'pause')).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledWith('/api/app-studio/apps/1/actions', expect.objectContaining({
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

    await expect(runAppAction(2, 'dispatch_ready_work')).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledWith('/api/app-studio/apps/2/actions', expect.objectContaining({
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

    await expect(getAppStudioSession(1)).rejects.toThrow('409: The current plan is blocked.');
  });

  it('reads and updates team config through the App-owned facade', async () => {
    const team = {
      company_session_id: 106,
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

    await expect(getAppTeamConfig(1)).resolves.toEqual(team);
    await expect(updateAppTeamConfig(1, { operational_rules: 'Always verify.' })).resolves.toEqual(team);
    expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/app-studio/apps/1/team/config');
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/app-studio/apps/1/team/config', expect.objectContaining({
      method: 'PATCH',
      body: JSON.stringify({ operational_rules: 'Always verify.' }),
    }));
  });
});
