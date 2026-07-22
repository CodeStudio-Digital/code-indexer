import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import type { LspApi } from '@mcp/api-bus';
import type { ServerDeps } from '../../../deps.js';
import { mountLspServerRoutes } from '../lsp-server.routes.js';

type AngularOverrideInput = Parameters<LspApi['setAngularProfileOverride']>[0];
type RestartInput = Parameters<LspApi['restartServer']>[0];
type LspInstance = Awaited<ReturnType<LspApi['instances']>>[number];

const ROUTED_INSTANCE: LspInstance = {
  projectId: 7,
  serverId: 'angular-12',
  routeId: 'lsp-route:angular-language-server:angular-12:opaque',
  familyId: 'angular-language-server',
  profileId: 'angular-12',
  state: 'ready',
};

function setup() {
  const overrides: AngularOverrideInput[] = [];
  const restarts: RestartInput[] = [];
  const handlers = {
    async instances() { return [ROUTED_INSTANCE]; },
    async restartServer(input: RestartInput) {
      restarts.push(input);
      return { ok: true as const };
    },
    async setAngularProfileOverride(input: AngularOverrideInput) {
      overrides.push(input);
      return { ok: true as const };
    },
  } as unknown as LspApi;
  const app = new Hono();
  mountLspServerRoutes(app, {} as ServerDeps, handlers);
  return { app, overrides, restarts };
}

async function put(app: Hono, body: string): Promise<Response> {
  return app.request('/api/lsp/7/angular-profile-overrides', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body,
  });
}

describe('LSP server HTTP routes', () => {
  it('keeps route identity fields in the instances response', async () => {
    const { app } = setup();
    const response = await app.request('/api/lsp/instances');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([ROUTED_INSTANCE]);
  });

  it.each([
    { workspacePath: 'apps/legacy', profileId: 'angular-12' },
    { workspacePath: '.', profileId: null },
  ])('accepts a valid Angular profile override: $profileId', async (body) => {
    const { app, overrides } = setup();
    const response = await put(app, JSON.stringify(body));

    expect(response.status).toBe(200);
    expect(overrides).toEqual([{ projectId: 7, ...body }]);
  });

  it('keeps the project id from the URL authoritative', async () => {
    const { app, overrides } = setup();
    const response = await put(app, JSON.stringify({
      projectId: 99,
      workspacePath: '.',
      profileId: 'angular-12',
    }));

    expect(response.status).toBe(200);
    expect(overrides).toEqual([{
      projectId: 7,
      workspacePath: '.',
      profileId: 'angular-12',
    }]);
  });

  it.each([
    ['malformed JSON', '{'],
    ['null', 'null'],
    ['array', '[]'],
    ['missing fields', '{}'],
    ['non-string workspacePath', '{"workspacePath":7,"profileId":"angular-12"}'],
    ['missing profileId', '{"workspacePath":"."}'],
    ['non-string profileId', '{"workspacePath":".","profileId":12}'],
  ])('returns 400 for %s instead of invoking the handler', async (_case, body) => {
    const { app, overrides } = setup();
    const response = await put(app, body);

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'workspacePath must be a string and profileId must be a string or null',
      code: 'bad_input',
    });
    expect(overrides).toEqual([]);
  });

  it('forwards a well-formed restart target', async () => {
    const { app, restarts } = setup();
    const response = await app.request('/api/lsp/7/servers/angular-12/restart', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ routeId: 'lsp-route:angular:12:opaque', file: 'src/app.ts' }),
    });

    expect(response.status).toBe(200);
    expect(restarts).toEqual([{
      projectId: 7,
      serverId: 'angular-12',
      routeId: 'lsp-route:angular:12:opaque',
      file: 'src/app.ts',
    }]);
  });

  it.each([
    ['malformed JSON', '{'],
    ['null', 'null'],
    ['array', '[]'],
    ['non-string routeId', '{"routeId":7}'],
    ['non-string file', '{"file":7}'],
  ])('returns 400 for restart %s', async (_case, body) => {
    const { app, restarts } = setup();
    const response = await app.request('/api/lsp/7/servers/angular-12/restart', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });

    expect(response.status).toBe(400);
    expect(restarts).toEqual([]);
  });
});
