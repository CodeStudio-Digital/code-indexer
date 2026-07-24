import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import type { SessionFilesystemAccess, SessionFilesystemRoot } from '@mcp/code-agent/sessions/types.js';
import type { ServerDeps } from '../../../deps.js';
import { mountCoderFilesystemRootRoutes } from '../filesystem-roots.js';

let projectRoot: string;
let externalRoot: string;

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'filesystem-root-route-project-'));
  externalRoot = mkdtempSync(join(tmpdir(), 'filesystem-root-route-external-'));
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
  rmSync(externalRoot, { recursive: true, force: true });
});

function fixture(status: 'idle' | 'running' = 'idle') {
  const roots: SessionFilesystemRoot[] = [];
  let nextId = 1;
  const sessionStore = {
    getSession: (id: number) => id === 1 ? { id: 1, project_id: 10, status } : null,
    getSessionProjects: () => [],
    listSessionFilesystemRoots: () => roots.slice(),
    upsertSessionFilesystemRoot: (_sessionId: number, rootPath: string, access: SessionFilesystemAccess) => {
      let row = roots.find((root) => root.root_path.toLowerCase() === rootPath.toLowerCase());
      if (!row) {
        row = {
          id: nextId++,
          session_id: 1,
          root_path: rootPath,
          access,
          created_at: 'now',
          updated_at: 'now',
        };
        roots.push(row);
      } else {
        row.access = access;
      }
      return row;
    },
    removeSessionFilesystemRoot: (_sessionId: number, rootId: number) => {
      const index = roots.findIndex((root) => root.id === rootId);
      if (index < 0) return false;
      roots.splice(index, 1);
      return true;
    },
    getDb: () => ({ prepare: () => ({ get: () => undefined }) }),
  };
  const app = new Hono();
  mountCoderFilesystemRootRoutes(app, {
    sessionStore,
    db: { getProject: (id: number) => id === 10 ? { root_path: projectRoot } : null },
  } as unknown as ServerDeps);
  return { app, roots };
}

describe('coder session filesystem-root routes', () => {
  it('adds, updates, lists and removes a canonical external directory', async () => {
    const { app } = fixture();
    const created = await app.request('/api/coder/sessions/1/filesystem-roots', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: externalRoot, access: 'read' }),
    });
    expect(created.status).toBe(201);
    const createdBody = await created.json() as { root: SessionFilesystemRoot };
    expect(createdBody.root.access).toBe('read');

    const updated = await app.request('/api/coder/sessions/1/filesystem-roots', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: externalRoot, access: 'write' }),
    });
    expect(updated.status).toBe(200);

    const listed = await app.request('/api/coder/sessions/1/filesystem-roots');
    const listedBody = await listed.json() as { roots: SessionFilesystemRoot[] };
    expect(listedBody.roots).toHaveLength(1);
    expect(listedBody.roots[0].access).toBe('write');

    const removed = await app.request(`/api/coder/sessions/1/filesystem-roots/${createdBody.root.id}`, {
      method: 'DELETE',
    });
    expect(removed.status).toBe(204);
  });

  it('rejects project-contained paths', async () => {
    const { app } = fixture();
    const nested = join(projectRoot, 'nested');
    mkdirSync(nested);
    const inside = await app.request('/api/coder/sessions/1/filesystem-roots', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: nested, access: 'read' }),
    });
    expect(inside.status).toBe(400);
    expect(await inside.json()).toMatchObject({ error: expect.stringContaining('already inside') });
  });

  it('labels exact attachment grants as files in the listing', async () => {
    const { app, roots } = fixture();
    const attachment = join(externalRoot, 'trace.tmp');
    writeFileSync(attachment, 'trace');
    roots.push({
      id: 1,
      session_id: 1,
      root_path: attachment,
      access: 'read',
      created_at: 'now',
      updated_at: 'now',
    });

    const listed = await app.request('/api/coder/sessions/1/filesystem-roots');
    expect(await listed.json()).toMatchObject({
      roots: [{ root_path: attachment, access: 'read', kind: 'file' }],
    });
  });

  it('rejects manual grant changes while a session is running', async () => {
    const { app } = fixture('running');
    const response = await app.request('/api/coder/sessions/1/filesystem-roots', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: externalRoot, access: 'read' }),
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining('session is running') });
  });
});
