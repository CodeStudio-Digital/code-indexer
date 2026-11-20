import { execFileSync } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { CoderWorktree } from '@mcp/api-bus';
import { sharedPtyManager } from '@mcp/api-handlers/terminal/pty-manager.js';
import { HttpRouter } from '@mcp/shared/http/router.js';
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
import { IN_PROCESS_ENV } from '../../../middleware/local-origin.js';

const { peekPool } = vi.hoisted(() => ({ peekPool: vi.fn() }));
vi.mock('../../../../sse/coderWorkerPoolSingleton.js', () => ({
  peekCoderWorkerPool: peekPool,
  getCoderWorkerPool: () => ({ abort: vi.fn(), isRunning: () => false, getBus: () => null }),
}));
let root: string;
let project: string;
let store: FsSessionStore;
let app: HttpRouter;
const post = (path: string, body: unknown) => app.request(`/api/coder/${path}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
}, IN_PROCESS_ENV);
const sessionBody = { project_id: 7, title: 'Worktree session', provider: 'openai', model: 'gpt-test' };
beforeEach(async () => {
  peekPool.mockReset().mockReturnValue(null);
  root = await mkdtemp(join(tmpdir(), 'codestudio-worktree-routes-'));
  project = join(root, 'project'); await mkdir(project);
  execFileSync('git', ['init', '-b', 'main'], { cwd: project, windowsHide: true });
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '--allow-empty', '-m', 'initial'], { cwd: project, windowsHide: true });
  store = FsSessionStore.fromRoots({ dataDir: join(root, 'data'), projectRootResolver: {
    resolveProjectRoot: () => project, listProjectRoots: () => [{ project_id: 7, root_path: project }],
  } });
  const getProject = (id: number) => id === 7 ? { id: 7, name: 'Fixture', root_path: project } : null;
  const deps = { sessionStore: store,
    db: { getProject, getProjectCatalogEntry: getProject },
    providerStore: { getProvider: () => ({ enabled: true }), listModels: () => [] },
  } as unknown as ServerDeps;
  app = new HttpRouter();
  mountCoderWorktreeRoutes(app, deps);
  mountCoderSessionsRoutes(app, deps, { activeRuns: new Map() } as unknown as CoderRuntime);
  mountCoderProjectTreeRoutes(app, deps);
  mountCoderSnapshotRoutes(app, deps);
});

describe('confirmed worktree removal', () => {
  const inventory = async (): Promise<CoderWorktree[]> => (await (await app.request('/api/coder/worktrees?project_id=7')).json()).worktrees;
  const git = (args: string[], cwd = project) => execFileSync('git', args, { cwd, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  async function linked(branch = 'claude/feature', path = join(root, 'outside checkout')) {
    git(['worktree', 'add', '-b', branch, '--', path]);
    return (await inventory()).find(item => item.branch === branch)!;
  }
  const remove = (item: CoderWorktree, options: Record<string, unknown> = {}) => post('worktrees/remove', {
    project_id: 7, path: item.path, branch: item.branch, head: item.head,
    confirmed: true, discardChanges: false, deleteBranch: false, ...options,
  });

  it('removes a registered external directory, keeps its branch and chat, and leaves the other worktrees alone', async () => {
    const item = await linked();
    const other = await linked('sibling', join(root, 'other'));
    const chat = await (await post('sessions', { ...sessionBody, worktree_path: item.path })).json();
    const response = await remove(item);
    expect(await response.json()).toEqual({ removed: true, branchDeleted: false });
    await expect(access(item.path)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(git(['rev-parse', '--verify', 'refs/heads/claude/feature'])).toBe(item.head);
    expect((await inventory()).map(entry => entry.branch).sort()).toEqual(['main', 'sibling']);
    await access(join(other.path, '.git'));
    expect(resolve((await store.getSession(chat.id))!.worktree_path!)).toBe(resolve(item.path));
    expect((await remove(item)).status).toBe(409);
  });

  it('keeps untracked files and the branch until discard and branch deletion are explicitly confirmed', async () => {
    const item = await linked();
    git(['config', 'status.showUntrackedFiles', 'no']);
    await writeFile(join(item.path, 'unsaved.txt'), 'only copy');
    const blocked = await remove(item, { deleteBranch: true });
    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toMatchObject({ code: 'dirty' });
    expect(await readFile(join(item.path, 'unsaved.txt'), 'utf8')).toBe('only copy');
    expect(git(['rev-parse', 'refs/heads/' + item.branch])).toBe(item.head);
    expect(await (await remove(item, { discardChanges: true, deleteBranch: true })).json()).toEqual({ removed: true, branchDeleted: true });
    expect(git(['branch', '--list', item.branch!])).toBe('');
    await expect(access(item.path)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects missing consent, stale commits, locked and unrelated paths, and both primary checkout identities', async () => {
    const item = await linked();
    expect((await remove(item, { confirmed: false })).status).toBe(400);
    expect((await app.request('/api/coder/worktrees/remove', { method: 'POST' })).status).toBe(403);
    expect((await remove(item, { deleteBranch: 'true' })).status).toBe(400);
    expect((await remove(item, { branch: 'main' })).status).toBe(409);
    expect((await remove(item, { path: root })).status).toBe(409);
    git(['-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '--allow-empty', '-m', 'new tip'], item.path);
    expect(await (await remove(item, { deleteBranch: true })).json()).toMatchObject({ code: 'changed' });
    git(['worktree', 'lock', '--', item.path]);
    project = item.path;
    const checkouts = await inventory();
    const repositoryMain = checkouts.find(entry => entry.branch === 'main')!;
    const projectCheckout = checkouts.find(entry => entry.primary)!;
    expect(repositoryMain.primary).toBe(false);
    expect(await (await remove(repositoryMain, { discardChanges: true })).json()).toMatchObject({ code: 'protected' });
    expect(await (await remove(projectCheckout, { discardChanges: true })).json()).toMatchObject({ code: 'protected' });
    project = repositoryMain.path;
    expect(await (await remove(projectCheckout, { discardChanges: true })).json()).toMatchObject({ code: 'protected' });
    await access(join(item.path, '.git'));
  });

  it('protects a checkout containing another registered checkout, and a checkout with an active chat', async () => {
    const item = await linked();
    const nested = await linked('nested', join(item.path, 'child'));
    expect(await (await remove(item, { discardChanges: true })).json()).toMatchObject({ code: 'nested' });
    const chat = await (await post('sessions', { ...sessionBody, worktree_path: nested.path })).json();
    peekPool.mockReturnValue({ snapshot: () => [{ sessionId: chat.id }], isRunning: () => true });
    expect(await (await remove(nested, { discardChanges: true })).json()).toMatchObject({ code: 'activeChat' });
    peekPool.mockReturnValue(null);
    const terminals = vi.spyOn(sharedPtyManager, 'listEntries').mockReturnValue([
      { id: 'fixture', pid: 42, meta: { label: 'Runner', kind: 'runner', cwd: join(nested.path, 'app') } },
    ]);
    try {
      expect(await (await remove(nested, { discardChanges: true })).json()).toMatchObject({ code: 'terminal' });
    } finally { terminals.mockRestore(); }
    await access(join(nested.path, '.git'));
  });

  it('reports a partial result if the branch is still in use elsewhere, and can remove a detached checkout', async () => {
    const item = await linked();
    git(['worktree', 'add', '--force', '--', join(root, 'shared branch'), item.branch!]);
    const response = await remove(item, { deleteBranch: true });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ removed: true, branchDeleted: false, branchWarning: expect.any(String) });
    expect(git(['rev-parse', 'refs/heads/' + item.branch])).toBe(item.head);
    git(['worktree', 'add', '--detach', '--', join(root, 'detached fixture'), item.head]);
    const detached = (await inventory()).find(entry => !entry.branch)!;
    expect((await remove(detached, { deleteBranch: true })).status).toBe(400);
    expect(await (await remove(detached)).json()).toEqual({ removed: true, branchDeleted: false });
  });

  it('removes only the selected missing Git registration and leaves a replacement directory intact', async () => {
    const item = await linked();
    const other = await linked('missing', join(root, 'missing'));
    // Both directories were made by this fixture, outside its main checkout.
    await rm(join(root, 'outside checkout'), { recursive: true });
    await rm(join(root, 'missing'), { recursive: true });
    await mkdir(join(root, 'outside checkout'));
    await writeFile(join(root, 'outside checkout', 'replacement.txt'), 'keep');
    expect((await remove(item, { discardChanges: true })).status).toBe(409);
    expect(await readFile(join(item.path, 'replacement.txt'), 'utf8')).toBe('keep');
    expect(await (await remove(other)).json()).toMatchObject({ removed: true, branchDeleted: false });
    expect((await inventory()).map(entry => entry.branch)).toContain(item.branch);
  });
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
