import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FsSessionStore } from '@mcp/session-storage/fs-store/fs-session-store.js';
import { mountCoderWorktreeRoutes } from '../worktrees.js';
import { mountCoderSessionsRoutes } from '../sessions.js';
import { mountCoderProjectTreeRoutes } from '../project-tree.routes.js';
import { mountCoderSnapshotRoutes } from '../snapshot.js';
import { resolveSessionWorkspaceRoot } from '@mcp/code-agent/tools/project-worktrees.js';
import { LocalFilesystemAdapter } from '@mcp/code-agent/ports/filesystem-port.js';
import { SnapshotRecorder, SnapshotRecordingFilesystemPort } from '@mcp/code-agent/ports/snapshot-recording-filesystem-port.js';
import type { ServerDeps } from '../../../deps.js';
import type { CoderRuntime } from '../state.js';

vi.mock('../../../../sse/coderWorkerPoolSingleton.js', () => ({
  getCoderWorkerPool: () => ({ abort: vi.fn(), isRunning: () => false, getBus: () => null }),
}));
let root: string;
let project: string;
let store: FsSessionStore;
let app: Hono;
const post = (path: string, body: unknown) => app.request(`/api/coder/${path}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});
const sessionBody = { project_id: 7, title: 'Worktree session', provider: 'openai', model: 'gpt-test' };
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'codestudio-worktree-routes-'));
  project = join(root, 'project'); await mkdir(project);
  execFileSync('git', ['init', '-b', 'main'], { cwd: project, windowsHide: true });
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '--allow-empty', '-m', 'initial'], { cwd: project, windowsHide: true });
  store = FsSessionStore.fromRoots({ dataDir: join(root, 'data'), projectRootResolver: {
    resolveProjectRoot: () => project, listProjectRoots: () => [{ project_id: 7, root_path: project }],
  } });
  const deps = { sessionStore: store,
    db: { getProject: (id: number) => id === 7 ? { id: 7, name: 'Fixture', root_path: project } : null },
    providerStore: { getProvider: () => ({ enabled: true }), listModels: () => [] },
  } as unknown as ServerDeps;
  app = new Hono();
  mountCoderWorktreeRoutes(app, deps);
  mountCoderSessionsRoutes(app, deps, { activeRuns: new Map() } as unknown as CoderRuntime);
  mountCoderProjectTreeRoutes(app, deps);
  mountCoderSnapshotRoutes(app, deps);
});
afterEach(async () => { await store.close(); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });

describe('worktree sessions HTTP integration', () => {
  it('creates a worktree, publishes several sessions there and reads its files', async () => {
    const created = await post('worktrees', { project_id: 7, name: 'feature', branch: 'codex/feature' });
    expect(created.status).toBe(201);
    const checkout = await created.json();
    await writeFile(join(checkout.path, 'only-worktree.txt'), 'isolated');
    await writeFile(join(project, 'only-main.txt'), 'main');
    const first = await post('sessions', { ...sessionBody, worktree_path: checkout.path });
    expect(first.status).toBe(201);
    const session = await first.json();
    expect(session.worktree_path).toBe(checkout.path);
    const second = await post('sessions', { ...sessionBody, worktree_path: checkout.path });
    expect(second.status).toBe(201);
    expect((await second.json()).worktree_path).toBe(checkout.path);
    const main = await post('sessions', sessionBody);
    expect((await main.json()).worktree_path).toBeNull();
    const tree = await app.request(`/api/coder/projects/7/tree?session_id=${session.id}`);
    expect(tree.status).toBe(200);
    expect((await tree.json()).entries.map((item: { name: string }) => item.name)).toEqual(['only-worktree.txt']);
    const inventory = await app.request('/api/coder/worktrees?project_id=7');
    expect((await inventory.json()).worktrees).toHaveLength(2);
  });

  it('rejects malformed options, foreign paths and missing projects before publishing a session', async () => {
    expect((await post('worktrees', { project_id: 7, name: '../escape' })).status).toBe(400);
    expect((await post('worktrees', { project_id: 7, branch: {} })).status).toBe(400);
    expect((await post('worktrees', { project_id: 99, name: 'test' })).status).toBe(404);
    expect((await post('sessions', { ...sessionBody, worktree_path: root })).status).toBe(400);
    expect((await post('sessions', { ...sessionBody, worktree_path: 42 })).status).toBe(400);
    const sessions = await app.request('/api/coder/sessions?project_id=7');
    expect(await sessions.json()).toEqual([]);
  });

  it('keeps missing checkout sessions bound and refuses to browse main as a fallback', async () => {
    const checkout = await (await post('worktrees', { project_id: 7, name: 'missing' })).json();
    const session = await (await post('sessions', { ...sessionBody, worktree_path: checkout.path })).json();
    // The best-effort base-commit probe can briefly hold cwd on Windows.
    await rm(checkout.path, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    const tree = await app.request(`/api/coder/projects/7/tree?session_id=${session.id}`);
    expect(tree.status).toBe(409);
    expect((await store.getSession(session.id))?.worktree_path).toBe(checkout.path);
    expect((await post('sessions', { ...sessionBody, worktree_path: checkout.path })).status).toBe(400);
  });

  it('records and reverts edits in the worktree without touching the same file in main', async () => {
    const checkout = await (await post('worktrees', { project_id: 7, name: 'snapshots' })).json();
    const session = await (await post('sessions', { ...sessionBody, worktree_path: checkout.path })).json();
    const rootPath = await resolveSessionWorkspaceRoot(project, session);
    expect(rootPath).toBe(checkout.path);
    await writeFile(join(project, 'example.txt'), 'main contents\n');
    await writeFile(join(rootPath, 'example.txt'), 'worktree before\n');
    const port = new SnapshotRecordingFilesystemPort(new LocalFilesystemAdapter(), new SnapshotRecorder({
      sessionKind: 'coder', sessionId: session.id, projectId: 7, projectRoot: rootPath, store,
    }));
    await port.writeFile(join(rootPath, 'example.txt'), 'worktree after\n');
    const inventory = await app.request(`/api/coder/sessions/${session.id}/snapshot`);
    expect(inventory.status).toBe(200);
    const files = (await inventory.json()).files;
    expect(files).toHaveLength(1);
    expect(files[0].filePath).toBe('example.txt');
    const reverted = await post(`sessions/${session.id}/snapshot/file/${files[0].baselineId}/revert`, {});
    expect(reverted.status).toBe(200);
    expect(await reverted.json()).toMatchObject({ ok: true });
    expect(await readFile(join(rootPath, 'example.txt'), 'utf8')).toBe('worktree before\n');
    expect(await readFile(join(project, 'example.txt'), 'utf8')).toBe('main contents\n');
  });
});
