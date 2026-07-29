import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { asSessionId } from '@mcp/agent-runtime-contracts';
import { mountCoderDriveRoutes } from '../drive.js';

const SESSION_ID = asSessionId('018f0f5e-7b2d-7a45-8c11-0123456789ab');
const MEMORY_ID = '018f0f5e-7b2d-7a45-8c11-0123456789ad';

function setup() {
  const sessionStore = {
    getDriveAggregate: vi.fn(async () => ({
      memory: [],
      investigations: [],
      fileMap: { read: [], changed: [] },
      plans: [],
      tasks: null,
    })),
    rememberMemory: vi.fn(async (_sessionId: string, input: { title: string }) => ({
      id: MEMORY_ID,
      title: input.title,
    })),
    setSessionMemoryPinned: vi.fn(async () => true),
    deleteSessionMemory: vi.fn(async () => true),
  };
  const app = new Hono();
  mountCoderDriveRoutes(app, { sessionStore } as never);
  return { app, sessionStore };
}

describe('coder Session Drive routes', () => {
  it('awaits filesystem projections before serializing them', async () => {
    const { app, sessionStore } = setup();
    const response = await app.request(`/api/coder/sessions/${SESSION_ID}/drive`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      memory: [],
      investigations: [],
      fileMap: { read: [], changed: [] },
      plans: [],
      tasks: null,
    });
    expect(sessionStore.getDriveAggregate).toHaveBeenCalledWith(SESSION_ID);
  });

  it('uses UUID record ids for pin and delete operations', async () => {
    const { app, sessionStore } = setup();
    const pin = await app.request(
      `/api/coder/sessions/${SESSION_ID}/drive/memory/${MEMORY_ID}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pinned: true }),
      },
    );
    const remove = await app.request(
      `/api/coder/sessions/${SESSION_ID}/drive/memory/${MEMORY_ID}`,
      { method: 'DELETE' },
    );

    expect(pin.status).toBe(200);
    expect(remove.status).toBe(200);
    expect(sessionStore.setSessionMemoryPinned).toHaveBeenCalledWith(
      SESSION_ID,
      MEMORY_ID,
      true,
    );
    expect(sessionStore.deleteSessionMemory).toHaveBeenCalledWith(
      SESSION_ID,
      MEMORY_ID,
    );
  });

  it('rejects legacy numeric session and memory ids', async () => {
    const { app } = setup();
    expect((await app.request('/api/coder/sessions/1/drive')).status).toBe(400);
    expect((await app.request(
      `/api/coder/sessions/${SESSION_ID}/drive/memory/1`,
      { method: 'DELETE' },
    )).status).toBe(400);
  });
});
