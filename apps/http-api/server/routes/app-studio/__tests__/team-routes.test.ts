import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import type { ServerDeps } from '../../../deps.js';
import { mountAppStudioTeamConfigRoutes } from '../team-routes.js';

describe('App team config routes', () => {
  it('round-trips scoped rules through the App route and rejects Company-only controls', async () => {
    let configJson = JSON.stringify({
      runtime_kind: 'app_studio',
      master_provider: 'openai',
      master_model: 'gpt-primary',
      role_assignments: [{
        role: 'frontend', enabled: true, provider: 'openai', model: 'gpt-primary', tier: 'full', fallbackModels: [],
      }],
      allowed_models: [{ provider: 'openai', model: 'gpt-primary', is_default: true }],
    });
    const appendEvent = vi.fn();
    const deps = {
      appStudioStore: {
        getSession: vi.fn(() => ({ id: 7, company_session_id: 90 })),
        appendEvent,
      },
      companyStore: {
        getCompanySession: vi.fn(() => ({
          id: 90,
          runtime_kind: 'app_studio',
          status: 'idle',
          master_session_id: 1265,
          config_json: configJson,
        })),
        updateCompanySessionConfig: vi.fn((_id: number, next: string) => { configJson = next; }),
      },
      sessionStore: {
        getSession: vi.fn(() => ({ id: 1265, provider: 'openai', model: 'gpt-primary' })),
      },
    } as unknown as ServerDeps;
    const app = new Hono();
    mountAppStudioTeamConfigRoutes(app, deps);

    const initial = await app.request('/api/app-studio/apps/7/team/config');
    expect(initial.status).toBe(200);
    await expect(initial.json()).resolves.toMatchObject({
      company_session_id: 90,
      roles: [expect.objectContaining({ role: 'master' }), expect.objectContaining({ role: 'frontend' })],
    });

    const saved = await app.request('/api/app-studio/apps/7/team/config', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ operational_rules: 'Require evidence.' }),
    });
    expect(saved.status).toBe(200);
    expect(JSON.parse(configJson)).toMatchObject({ operational_rules: 'Require evidence.' });
    expect(appendEvent).toHaveBeenCalledWith(
      7,
      'team.config_updated',
      'company_session',
      '90',
      JSON.stringify({ changed_keys: ['operational_rules'] }),
    );

    const forbidden = await app.request('/api/app-studio/apps/7/team/config', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ autonomy: { freeze: true } }),
    });
    expect(forbidden.status).toBe(400);
    await expect(forbidden.json()).resolves.toEqual({ error: 'Unsupported App team config: autonomy' });
  });
});
