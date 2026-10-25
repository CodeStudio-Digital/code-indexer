import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { asSessionId, type SessionId } from '@mcp/agent-runtime-contracts';
import type { TrashResult } from '@mcp/session-storage';
import type { ServerDeps } from '../../../deps.js';
import type { CoderRuntime } from '../state.js';
import { mountCoderSessionsRoutes } from '../sessions.js';

const abort = vi.fn(async () => undefined);
vi.mock('../../../../sse/coderWorkerPoolSingleton.js', () => ({
  getCoderWorkerPool: () => ({
    abort,
    getBus: vi.fn(() => null),
    isRunning: vi.fn(() => false),
  }),
}));

const PROJECT_SESSION = asSessionId('11111111-1111-4111-8111-111111111111');
const GLOBAL_SESSION = asSessionId('22222222-2222-4222-8222-222222222222');

function trashResult(
  sessionId: SessionId,
  scope: TrashResult['location']['scope'],
  suffix: string,
): TrashResult {
  const sessionRoot = scope.kind === 'global' ? 'D:\\data\\sessions\\global' : 'D:\\project\\.mcp-indexer\\session';
  const trashName =
    `${sessionId}-2026-07-27T12-34-56-789Z-${suffix}`;
  return {
    location: {
      session_id: sessionId,
      scope,
      session_root: sessionRoot,
      bundle_path: `${sessionRoot}\\${sessionId}`,
    },
    trash_name: trashName,
    trash_path: `${sessionRoot}\\.trash\\${trashName}`,
    trashed_at: '2026-07-27T12:34:56.789Z',
  };
}

function setup() {
  abort.mockClear();
  const projectTrash = trashResult(
    PROJECT_SESSION,
    { kind: 'project', project_id: 7 },
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  );
  const globalTrash = trashResult(
    GLOBAL_SESSION,
    { kind: 'global' },
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  );
  const byId = new Map<SessionId, TrashResult>([
    [PROJECT_SESSION, projectTrash],
    [GLOBAL_SESSION, globalTrash],
  ]);
  const sessionStore = {
    getSession: async (id: SessionId) => ({
      id,
      is_global: id === GLOBAL_SESSION,
    }),
    deleteSession: async (id: SessionId) => byId.get(id)!,
    trashSessionsBatch: async (ids: SessionId[]) => ids.map((id) => byId.get(id)!),
  };
  const app = new Hono();
  mountCoderSessionsRoutes(
    app,
    { sessionStore, providerStore: {} } as unknown as ServerDeps,
    { activeRuns: new Map() } as unknown as CoderRuntime,
  );
  return { app, projectTrash, globalTrash };
}

describe('coder recoverable delete responses', () => {
  it('returns the restore token and explicit scope for one session', async () => {
    const { app, projectTrash } = setup();
    const response = await app.request(`/api/coder/sessions/${PROJECT_SESSION}`, {
      method: 'DELETE',
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      session_id: PROJECT_SESSION,
      trash_name: projectTrash.trash_name,
      trashed_at: projectTrash.trashed_at,
      scope: { kind: 'project', project_id: 7 },
    });
  });

  it('keeps deleted count while returning one token per batch item', async () => {
    const { app, projectTrash, globalTrash } = setup();
    const response = await app.request('/api/coder/sessions/batch-delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [PROJECT_SESSION, GLOBAL_SESSION] }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      deleted: 2,
      items: [
        {
          session_id: PROJECT_SESSION,
          trash_name: projectTrash.trash_name,
          trashed_at: projectTrash.trashed_at,
          scope: { kind: 'project', project_id: 7 },
        },
        {
          session_id: GLOBAL_SESSION,
          trash_name: globalTrash.trash_name,
          trashed_at: globalTrash.trashed_at,
          scope: { kind: 'global' },
        },
      ],
    });
    expect(abort).toHaveBeenCalledWith(GLOBAL_SESSION);
  });
});
