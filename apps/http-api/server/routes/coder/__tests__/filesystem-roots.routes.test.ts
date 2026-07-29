import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import {
  asSessionId,
  newSessionId,
  type SessionId,
} from '@mcp/session-storage';
import type { SessionFilesystemAccess } from '@mcp/code-agent/sessions/types.js';
import type { FsSessionFilesystemRoot } from '@mcp/code-agent/sessions/fs-store/operational-types.js';
import type { ServerDeps } from '../../../deps.js';
import { mountCoderFilesystemRootRoutes } from '../filesystem-roots.js';

const SESSION_ID = asSessionId('11111111-1111-4111-8111-111111111111');

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
  const roots: FsSessionFilesystemRoot[] = [];
  const baselines: Array<{ project_id: number | null }> = [];
  let nextSeq = 1;
  const sessionStore = {
    getSession: (id: SessionId) => id === SESSION_ID ? { id, project_id: 10, status } : null,
    getSessionProjects: () => [],
    listSessionFilesystemRoots: () => roots.slice(),
    upsertSessionFilesystemRoot: (_sessionId: SessionId, rootPath: string, access: SessionFilesystemAccess) => {
      let row = roots.find((root) => root.root_path.toLowerCase() === rootPath.toLowerCase());
      if (!row) {
        row = {
          id: newSessionId(),
          seq: nextSeq++,
          revision: 1,
          session_id: SESSION_ID,
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
    removeSessionFilesystemRoot: (_sessionId: SessionId, rootId: string) => {
      const index = roots.findIndex((root) => root.id === rootId);
      if (index < 0) return false;
      roots.splice(index, 1);
      return true;
    },
    listBaselines: () => baselines.slice(),
  };
  const app = new Hono();
  mountCoderFilesystemRootRoutes(app, {
    sessionStore,
    db: { getProject: (id: number) => id === 10 ? { root_path: projectRoot } : null },
  } as unknown as ServerDeps);
  return { app, roots, baselines };
}

describe('coder session filesystem-root routes', () => {
  it('adds, updates, lists and removes a canonical external directory', async () => {
    const { app } = fixture();
    const created = await app.request(`/api/coder/sessions/${SESSION_ID}/filesystem-roots`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: externalRoot, access: 'read' }),
    });
    expect(created.status).toBe(201);
    const createdBody = await created.json() as { root: FsSessionFilesystemRoot };
    expect(createdBody.root.access).toBe('read');

    const updated = await app.request(`/api/coder/sessions/${SESSION_ID}/filesystem-roots`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: externalRoot, access: 'write' }),
    });
    expect(updated.status).toBe(200);

    const listed = await app.request(`/api/coder/sessions/${SESSION_ID}/filesystem-roots`);
    const listedBody = await listed.json() as { roots: FsSessionFilesystemRoot[] };
    expect(listedBody.roots).toHaveLength(1);
    expect(listedBody.roots[0].access).toBe('write');

    const removed = await app.request(`/api/coder/sessions/${SESSION_ID}/filesystem-roots/${createdBody.root.id}`, {
      method: 'DELETE',
    });
    expect(removed.status).toBe(204);
  });

  it('rejects project-contained paths', async () => {
    const { app } = fixture();
    const nested = join(projectRoot, 'nested');
    mkdirSync(nested);
    const inside = await app.request(`/api/coder/sessions/${SESSION_ID}/filesystem-roots`, {
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
      id: newSessionId(),
      seq: 1,
      revision: 1,
      session_id: SESSION_ID,
      root_path: attachment,
      access: 'read',
      created_at: 'now',
      updated_at: 'now',
    });

    const listed = await app.request(`/api/coder/sessions/${SESSION_ID}/filesystem-roots`);
    expect(await listed.json()).toMatchObject({
      roots: [{ root_path: attachment, access: 'read', kind: 'file' }],
    });
  });

  it('rejects manual grant changes while a session is running', async () => {
    const { app } = fixture('running');
    const response = await app.request(`/api/coder/sessions/${SESSION_ID}/filesystem-roots`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: externalRoot, access: 'read' }),
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining('session is running') });
  });

  it('keeps a write grant while its filesystem snapshots are pending', async () => {
    const { app, roots, baselines } = fixture();
    roots.push({
      id: newSessionId(),
      seq: 3,
      revision: 1,
      session_id: SESSION_ID,
      root_path: externalRoot,
      access: 'write',
      created_at: 'now',
      updated_at: 'now',
    });
    baselines.push({ project_id: -3 });

    const response = await app.request(
      `/api/coder/sessions/${SESSION_ID}/filesystem-roots/${roots[0]!.id}`,
      { method: 'DELETE' },
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: expect.stringContaining('pending file snapshots'),
    });
  });
});
