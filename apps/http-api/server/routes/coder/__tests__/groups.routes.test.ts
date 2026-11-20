import { HttpRouter } from '@mcp/shared/http/router.js';
import { describe, expect, it, vi } from 'vitest';
import type { ServerDeps } from '../../../deps.js';
import { mountCoderGroupsRoutes } from '../groups.js';

const GROUP_ID = '11111111-1111-4111-8111-111111111111';

function setup() {
  const group = {
    id: GROUP_ID,
    seq: 1,
    project_id: 7,
    name: 'Backend',
    color: null,
    sort_order: 0,
    created_at: '2026-07-26T12:00:00.000Z',
    updated_at: '2026-07-26T12:00:00.000Z',
  };
  const sessionStore = {
    listGroups: vi.fn(async () => [group]),
    createGroup: vi.fn(async () => group),
    updateGroup: vi.fn(async () => ({ ...group, name: 'API' })),
    deleteGroup: vi.fn(async () => true),
  };
  const app = new HttpRouter();
  mountCoderGroupsRoutes(app, {
    sessionStore,
  } as unknown as ServerDeps);
  return { app, sessionStore };
}

describe('filesystem coder group routes', () => {
  it('keeps the route paths while using project-scoped UUID records', async () => {
    const { app, sessionStore } = setup();

    expect(
      (await app.request('/api/coder/groups?project_id=7')).status,
    ).toBe(200);
    const created = await app.request('/api/coder/groups', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ project_id: 7, name: 'Backend' }),
    });
    expect(created.status).toBe(201);
    expect(sessionStore.createGroup).toHaveBeenCalledWith(7, {
      name: 'Backend',
      color: null,
    });

    const updated = await app.request(
      `/api/coder/groups/${GROUP_ID}?project_id=7`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'API' }),
      },
    );
    expect(updated.status).toBe(200);
    expect(sessionStore.updateGroup).toHaveBeenCalledWith(
      7,
      GROUP_ID,
      { name: 'API' },
    );

    const removed = await app.request(
      `/api/coder/groups/${GROUP_ID}?project_id=7`,
      { method: 'DELETE' },
    );
    expect(removed.status).toBe(200);
    expect(sessionStore.deleteGroup).toHaveBeenCalledWith(7, GROUP_ID);
  });

  it('fails closed without the essential project scope or with a numeric id', async () => {
    const { app } = setup();
    expect((await app.request('/api/coder/groups')).status).toBe(400);
    expect(
      (
        await app.request('/api/coder/groups/9?project_id=7', {
          method: 'DELETE',
        })
      ).status,
    ).toBe(400);
  });
});
