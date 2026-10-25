import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { ChatCollaborationStore } from '@mcp/session-storage/collaboration/store.js';
import type { ToolContext } from '../../core/tool.js';
import { defaultLocalFilesystemPort } from '../../ports/filesystem-port.js';
import { archiveIntegratedWorkspace, captureUltraWorkspace, confinedWorkspaceFilesystem, integrateUltraWorkspace, prepareUltraWorkspace } from '../ultra-workspace.js';
import { lockUltraIntegration } from '../ultra-integration-lock.js';
import { UltraAgentBudget } from '../ultra-budget.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'ultra-git-')); roots.push(root);
  const source = join(root, 'project'); await mkdir(source);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: source, windowsHide: true, stdio: 'pipe' });
  git('init'); git('config', 'user.email', 'test@example.test'); git('config', 'user.name', 'Test'); git('config', 'core.autocrlf', 'false');
  await writeFile(join(source, '.gitignore'), '.mcp-indexer/\n');
  await writeFile(join(source, 'file.txt'), 'committed\n');
  git('add', '.'); git('commit', '-m', 'baseline');
  await writeFile(join(source, 'file.txt'), 'uncommitted\n');
  await writeFile(join(source, 'new.txt'), 'untracked\n');
  const store = new ChatCollaborationStore(join(root, 'data')); await store.init();
  const ctx = { cwd: source, sessionId: 'test', collaboration: { actor: 'chat:test', store }, ports: { fs: defaultLocalFilesystemPort() } } as ToolContext;
  return { source, ctx };
}
describe('Ultra implementation isolation', () => {
  it('copies current work, confines native writes, integrates once and preserves the source index', async () => {
    const { source, ctx } = await fixture();
    const workspace = await prepareUltraWorkspace(ctx, 'child');
    expect(await readFile(join(workspace.path, 'file.txt'), 'utf8')).toBe('uncommitted\n');
    expect(await readFile(join(workspace.path, 'new.txt'), 'utf8')).toBe('untracked\n');
    const fs = confinedWorkspaceFilesystem(workspace.path);
    const entries = []; for await (const entry of fs.iterateDirectory!(workspace.path)) entries.push(entry.name);
    expect(entries).toContain('file.txt');
    await expect(fs.writeFile(join(source, 'file.txt'), 'escape')).rejects.toThrow('escapes');
    await fs.writeFile(join(workspace.path, 'file.txt'), 'implemented\n');
    await fs.createFile!(join(workspace.path, 'created.txt'), 'new implementation\n');
    expect(await readFile(join(source, 'file.txt'), 'utf8')).toBe('uncommitted\n');
    const captured = await captureUltraWorkspace(workspace);
    await integrateUltraWorkspace(ctx, captured);
    await integrateUltraWorkspace(ctx, captured); // receipt publication can be retried safely
    expect(await readFile(join(source, 'file.txt'), 'utf8')).toBe('implemented\n');
    expect(execFileSync('git', ['diff', '--cached', '--name-only'], { cwd: source, encoding: 'utf8', windowsHide: true })).toBe('');
    await archiveIntegratedWorkspace(captured);
  }, 60_000);
  it('refuses a concurrent owner and detects overlap before applying any file', async () => {
    const { source, ctx } = await fixture();
    const workspace = await prepareUltraWorkspace(ctx, 'child');
    await writeFile(join(workspace.path, 'file.txt'), 'child\n');
    await writeFile(join(workspace.path, 'created.txt'), 'must not appear\n');
    const captured = await captureUltraWorkspace(workspace);
    const unlock = await lockUltraIntegration(source);
    await expect(integrateUltraWorkspace(ctx, captured)).rejects.toThrow('locked'); await unlock();
    await writeFile(join(source, 'file.txt'), 'concurrent owner\n');
    await expect(integrateUltraWorkspace(ctx, captured)).rejects.toThrow('conflict');
    await expect(readFile(join(source, 'created.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(source, 'file.txt'), 'utf8')).toBe('concurrent owner\n');
    await archiveIntegratedWorkspace(captured);
  }, 60_000);
  it('rolls back earlier writes when a later write fails', async () => {
    const { source, ctx } = await fixture();
    const workspace = await prepareUltraWorkspace(ctx, 'child');
    await writeFile(join(workspace.path, 'aaa.txt'), 'first\n');
    await writeFile(join(workspace.path, 'file.txt'), 'second\n');
    const captured = await captureUltraWorkspace(workspace);
    const local = defaultLocalFilesystemPort(); let failed = false;
    ctx.ports!.fs = new Proxy(local, { get(target, key) {
      if (key === 'writeFile') return async (path: string, value: string) => {
        if (!failed && path.endsWith('file.txt')) { failed = true; throw new Error('disk failure'); }
        return target.writeFile(path, value);
      };
      const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
    } });
    await expect(integrateUltraWorkspace(ctx, captured)).rejects.toThrow('disk failure');
    await expect(readFile(join(source, 'aaa.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(source, 'file.txt'), 'utf8')).toBe('uncommitted\n');
    await archiveIntegratedWorkspace(captured);
  }, 60_000);
  it('limits parallel agents, wakes queued work and releases aborted waits', async () => {
    const budget = new UltraAgentBudget(1, 2);
    const first = await budget.acquire();
    const abort = new AbortController();
    const cancelled = budget.acquire(abort.signal); abort.abort();
    await expect(cancelled).rejects.toBeDefined();
    let admitted = false;
    const second = budget.acquire().then(release => { admitted = true; return release; });
    await Promise.resolve(); expect(admitted).toBe(false); first();
    (await second)(); await expect(budget.acquire()).rejects.toThrow('budget');
  });
});
