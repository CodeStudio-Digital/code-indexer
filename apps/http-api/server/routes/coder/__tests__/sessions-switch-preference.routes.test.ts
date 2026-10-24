import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { asSessionId } from '@mcp/agent-runtime-contracts';
import type { ServerDeps } from '../../../deps.js';
import type { CoderRuntime } from '../state.js';

const SESSION_ID = asSessionId(
  '77777777-7777-4777-8777-777777777777',
);

const mocks = vi.hoisted(() => ({
  swapProvider: vi.fn(),
  createProvider: vi.fn(),
}));

vi.mock('@mcp/services/providers/factory.js', () => ({
  createCoderProvider: mocks.createProvider,
}));

vi.mock('../../../../sse/coderWorkerPoolSingleton.js', () => ({
  getCoderWorkerPool: () => ({
    abort: vi.fn(),
    getBus: () => null,
    swapProvider: mocks.swapProvider,
  }),
}));

import { mountCoderInteractionRoutes } from '../interaction.js';

function setup(sessionExists = true) {
  const updateSessionProvider = vi.fn(async () => undefined);
  const coderPreferences = {
    setLastSelectedModel: vi.fn(async () => undefined),
  };
  const deps = {
    sessionStore: {
      getSession: vi.fn(async () => (
        sessionExists
          ? {
              id: SESSION_ID,
              provider: 'zai',
              model: 'glm-5.2',
            }
          : null
      )),
      updateSessionProvider,
    },
    coderPreferences,
  } as unknown as ServerDeps;
  const app = new Hono();
  mountCoderInteractionRoutes(app, deps, {
    findPendingInteraction: vi.fn(),
    findDanglingToolUse: vi.fn(),
  } as unknown as CoderRuntime);
  return { app, coderPreferences, updateSessionProvider };
}

beforeEach(() => {
  mocks.swapProvider.mockReset().mockResolvedValue(false);
  mocks.createProvider.mockReset().mockResolvedValue({
    model: 'gpt-5.4',
  });
});

describe('coder provider switch preference', () => {
  it('persists the effective provider/model after a successful switch', async () => {
    const { app, coderPreferences, updateSessionProvider } = setup();

    const response = await app.request(
      `/api/coder/sessions/${SESSION_ID}/switch`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: 'openai',
          model: 'gpt-5.4',
        }),
      },
    );

    expect(response.status).toBe(200);
    expect(updateSessionProvider).toHaveBeenCalledWith(
      SESSION_ID,
      'openai',
      'gpt-5.4',
    );
    expect(coderPreferences.setLastSelectedModel).toHaveBeenCalledWith(
      'openai',
      'gpt-5.4',
    );
  });

  it('does not change the preference when the session does not exist', async () => {
    const { app, coderPreferences } = setup(false);

    const response = await app.request(
      `/api/coder/sessions/${SESSION_ID}/switch`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: 'openai',
          model: 'gpt-5.4',
        }),
      },
    );

    expect(response.status).toBe(404);
    expect(coderPreferences.setLastSelectedModel).not.toHaveBeenCalled();
  });
});
