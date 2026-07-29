import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import type { ServerDeps } from '../../../deps.js';

const APP_ID = '00000007-0000-4000-8000-000000000000';
const COMPANY_ID = '0000005a-0000-4000-8000-000000000000';
const MASTER_ID = '000004f1-0000-4000-8000-000000000000';
const APP_URL = `/api/app-studio/apps/${APP_ID}/team/config`;

const companyFiles = vi.hoisted(() => ({
  getSession: vi.fn(),
  updateSessionConfig: vi.fn(),
}));

vi.mock('@mcp/company/services/CompanySessionFiles.js', () => ({
  CompanySessionFiles: class {
    getSession = companyFiles.getSession;
    updateSessionConfig = companyFiles.updateSessionConfig;
  },
}));

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
    companyFiles.getSession.mockImplementation(() => ({ config_json: configJson }));
    companyFiles.updateSessionConfig.mockImplementation(async (next: string) => {
      configJson = next;
    });
    const deps = {
      appStudioStore: {
        getSession: vi.fn(() => ({ id: APP_ID, company_session_id: COMPANY_ID })),
        appendEvent,
      },
      operationalSessionFiles: {
        getCompanySession: vi.fn(() => ({
          id: COMPANY_ID,
          runtime_kind: 'app_studio',
          status: 'idle',
          master_session_id: MASTER_ID,
          config_json: configJson,
        })),
      },
      sessionStore: {
        getSession: vi.fn(() => ({ id: MASTER_ID, provider: 'openai', model: 'gpt-primary' })),
      },
    } as unknown as ServerDeps;
    const app = new Hono();
    mountAppStudioTeamConfigRoutes(app, deps);

    const initial = await app.request(APP_URL);
    expect(initial.status).toBe(200);
    await expect(initial.json()).resolves.toMatchObject({
      company_session_id: COMPANY_ID,
      roles: [expect.objectContaining({ role: 'master' }), expect.objectContaining({ role: 'frontend' })],
    });

    const saved = await app.request(APP_URL, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ operational_rules: 'Require evidence.' }),
    });
    expect(saved.status).toBe(200);
    expect(JSON.parse(configJson)).toMatchObject({ operational_rules: 'Require evidence.' });
    expect(appendEvent).toHaveBeenCalledWith(
      APP_ID,
      'team.config_updated',
      'company_session',
      COMPANY_ID,
      JSON.stringify({ changed_keys: ['operational_rules'] }),
    );

    const forbidden = await app.request(APP_URL, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ autonomy: { freeze: true } }),
    });
    expect(forbidden.status).toBe(400);
    await expect(forbidden.json()).resolves.toEqual({ error: 'Unsupported App team config: autonomy' });
  });
});
