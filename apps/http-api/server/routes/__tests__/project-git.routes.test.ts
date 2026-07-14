import { afterAll, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { mountProjectGitRoutes } from '../project-git.js';

const root = mkdtempSync(join(tmpdir(), 'mcp-git-http-'));
spawnSync('git', ['init', '-b', 'main'], { cwd: root });
spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
spawnSync('git', ['config', 'user.name', 'Test'], { cwd: root });
writeFileSync(join(root, 'base.txt'), 'base\n');
spawnSync('git', ['add', '.'], { cwd: root });
spawnSync('git', ['commit', '-m', 'base'], { cwd: root });

afterAll(() => rmSync(root, { recursive: true, force: true }));

function app() {
  const hono = new Hono();
  mountProjectGitRoutes(hono, {
    db: { getProject: (id: number) => id === 1 ? { id, name: 'Test', root_path: root } : null },
  } as never);
  return hono;
}

function request(hono: Hono, path: string, init: RequestInit, peer = '127.0.0.1') {
  return hono.request(path, init, { incoming: { socket: { remoteAddress: peer } } } as never);
}

describe('project git HTTP RPC', () => {
  it('provides browser parity through the allowlisted RPC endpoint', async () => {
    const response = await request(app(), '/api/projects/1/git/rpc/status', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://localhost:5173' },
      body: JSON.stringify({ includeFiles: false }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ branch: 'main', notARepo: false });
  });

  it('rejects remote browser origins and unknown methods', async () => {
    const remote = await request(app(), '/api/projects/1/git/rpc/status', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
      body: '{}',
    });
    expect(remote.status).toBe(403);

    const unknown = await request(app(), '/api/projects/1/git/rpc/notReal', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://localhost:5173' },
      body: '{}',
    });
    expect(unknown.status).toBe(404);
  });

  it('rejects a remote TCP peer and a sandboxed null origin', async () => {
    const remotePeer = await request(app(), '/api/projects/1/git/rpc/status', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://localhost:5173' },
      body: '{}',
    }, '192.168.1.20');
    expect(remotePeer.status).toBe(403);

    const nullOrigin = await request(app(), '/api/projects/1/git/rpc/status', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'null' },
      body: '{}',
    });
    expect(nullOrigin.status).toBe(403);
  });
});
