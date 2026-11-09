import { afterAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createProjectGitHandlers, disposeProjectGitProcesses } from '../index.js';

const dirs: string[] = [];
afterAll(async () => {
  await disposeProjectGitProcesses();
  for (const dir of dirs) {
    if (dirname(resolve(dir)) !== resolve(tmpdir()) || !basename(dir).startsWith('mcp-pull-update-')) throw new Error('Unsafe fixture cleanup');
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

function temp() { const dir = mkdtempSync(join(tmpdir(), 'mcp-pull-update-')); dirs.push(dir); return dir; }
function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', ['-c', 'core.fsmonitor=false', ...args], { cwd, encoding: 'utf8', windowsHide: true, timeout: 30_000 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || `git ${args[0]} failed`);
  return result.stdout.trim();
}
function configure(root: string) {
  git(root, 'config', 'user.email', 'fixture@example.invalid');
  git(root, 'config', 'user.name', 'Update Fixture');
  git(root, 'config', 'commit.gpgsign', 'false');
  git(root, 'config', 'core.autocrlf', 'false');
  git(root, 'config', 'core.fsmonitor', 'false');
  git(root, 'config', 'core.hooksPath', process.platform === 'win32' ? 'NUL' : '/dev/null');
}
function setup() {
  const root = temp(), remote = temp(), other = temp();
  git(remote, 'init', '--bare');
  git(root, 'init', '-b', 'main'); configure(root);
  for (const file of ['local.txt', 'remote.txt', 'staged.txt', 'shared.txt']) writeFileSync(join(root, file), 'base\n');
  git(root, 'add', '.'); git(root, 'commit', '-m', 'base');
  git(root, 'remote', 'add', 'origin', remote); git(root, 'push', '-u', 'origin', 'main');
  git(other, 'clone', '--branch', 'main', remote, '.'); configure(other);
  const handlers = createProjectGitHandlers({ db: { getProjectRootPath: (id: number) => id === 1 ? root : undefined } } as never);
  const advance = (file: string, content: string) => {
    writeFileSync(join(other, file), content); git(other, 'add', file);
    git(other, 'commit', '-m', 'remote update'); git(other, 'push', 'origin', 'main');
    return git(other, 'rev-parse', 'HEAD');
  };
  const pull = () => handlers.pull({ projectId: 1, rebase: true }, {} as never);
  return { root, remote, other, handlers, advance, pull };
}

describe('Update Project with local edits', () => {
  it('updates with staged and unstaged edits, preserving file contents, new files and older stashes', async () => {
    const { root, advance, pull } = setup();
    writeFileSync(join(root, 'local.txt'), 'older saved work\n');
    git(root, 'stash', 'push', '-m', 'existing-user-stash');
    const stash = git(root, 'rev-parse', 'refs/stash');
    writeFileSync(join(root, 'local.txt'), 'current local work\n');
    writeFileSync(join(root, 'staged.txt'), 'current staged work\n'); git(root, 'add', 'staged.txt');
    writeFileSync(join(root, 'new untracked.txt'), 'new local file\n');
    const upstream = advance('remote.txt', 'incoming remote work\n');
    const result = await pull();
    expect(result.ok, result.stderr).toBe(true);
    expect(git(root, 'rev-parse', 'HEAD')).toBe(upstream);
    expect(readFileSync(join(root, 'local.txt'), 'utf8')).toBe('current local work\n');
    expect(readFileSync(join(root, 'staged.txt'), 'utf8')).toBe('current staged work\n');
    expect(readFileSync(join(root, 'new untracked.txt'), 'utf8')).toBe('new local file\n');
    expect(git(root, 'rev-parse', 'refs/stash')).toBe(stash);
  }, 60_000);

  it('reports a conflict when reapplying local edits instead of trusting a zero Git exit code', async () => {
    const { root, handlers, advance, pull } = setup();
    writeFileSync(join(root, 'shared.txt'), 'local edit\n');
    const upstream = advance('shared.txt', 'remote edit\n');
    const result = await pull();
    expect(result).toMatchObject({ ok: false, updateActionRequired: 'conflicts', conflictedFiles: ['shared.txt'] });
    expect(git(root, 'rev-parse', 'HEAD')).toBe(upstream);
    expect(await handlers.mergeState({ projectId: 1 }, {} as never)).toMatchObject({ kind: 'working-tree', conflictedFiles: ['shared.txt'] });
    expect(git(root, 'show', 'stash@{0}:shared.txt')).toBe('local edit');
    const content = readFileSync(join(root, 'shared.txt'), 'utf8');
    expect(content).toContain('local edit'); expect(content).toContain('remote edit');
  }, 60_000);

  it('restores local edits and the original commit when aborting a conflicted rebase', async () => {
    const { root, handlers, advance, pull } = setup();
    writeFileSync(join(root, 'shared.txt'), 'local committed edit\n');
    git(root, 'commit', '-am', 'local commit');
    const originalHead = git(root, 'rev-parse', 'HEAD');
    writeFileSync(join(root, 'local.txt'), 'work in progress\n');
    advance('shared.txt', 'remote committed edit\n');
    expect(await pull()).toMatchObject({ ok: false, updateActionRequired: 'conflicts' });
    expect(await handlers.mergeState({ projectId: 1 }, {} as never)).toMatchObject({ kind: 'rebase' });
    const aborted = await handlers.mergeAbort({ projectId: 1 }, {} as never);
    expect(aborted.ok, aborted.stderr).toBe(true);
    expect(git(root, 'rev-parse', 'HEAD')).toBe(originalHead);
    expect(readFileSync(join(root, 'local.txt'), 'utf8')).toBe('work in progress\n');
    expect(readFileSync(join(root, 'shared.txt'), 'utf8')).toBe('local committed edit\n');
    expect(await handlers.mergeState({ projectId: 1 }, {} as never)).toMatchObject({ kind: null, conflictedFiles: [] });
  }, 60_000);

  it('restores local edits after resolving and continuing a conflicted rebase', async () => {
    const { root, handlers, advance, pull } = setup();
    writeFileSync(join(root, 'shared.txt'), 'local committed edit\n');
    git(root, 'commit', '-am', 'local commit');
    writeFileSync(join(root, 'local.txt'), 'work in progress\n');
    const upstream = advance('shared.txt', 'remote committed edit\n');
    expect(await pull()).toMatchObject({ ok: false, updateActionRequired: 'conflicts' });
    await handlers.resolveConflict({ projectId: 1, path: 'shared.txt', resolution: { content: 'combined resolution\n' } }, {} as never);
    const continued = await handlers.mergeContinue({ projectId: 1 }, {} as never);
    expect(continued.ok, continued.stderr).toBe(true);
    expect(git(root, 'rev-parse', 'HEAD^')).toBe(upstream);
    expect(readFileSync(join(root, 'local.txt'), 'utf8')).toBe('work in progress\n');
    expect(readFileSync(join(root, 'shared.txt'), 'utf8')).toBe('combined resolution\n');
    expect(await handlers.mergeState({ projectId: 1 }, {} as never)).toMatchObject({ kind: null, conflictedFiles: [] });
  }, 60_000);

  it('preserves edits and existing stashes when the remote cannot be fetched', async () => {
    const { root, remote, pull } = setup();
    writeFileSync(join(root, 'local.txt'), 'older saved work\n');
    git(root, 'stash', 'push', '-m', 'existing-user-stash');
    const stash = git(root, 'rev-parse', 'refs/stash');
    const originalHead = git(root, 'rev-parse', 'HEAD');
    writeFileSync(join(root, 'local.txt'), 'current local work\n');
    git(root, 'remote', 'set-url', 'origin', join(remote, 'unavailable.git'));
    const result = await pull();
    expect(result.ok).toBe(false);
    expect(result.updateActionRequired).toBeUndefined();
    expect(git(root, 'rev-parse', 'HEAD')).toBe(originalHead);
    expect(readFileSync(join(root, 'local.txt'), 'utf8')).toBe('current local work\n');
    expect(git(root, 'rev-parse', 'refs/stash')).toBe(stash);
  }, 60_000);

  it('refuses to overwrite an untracked file introduced upstream and restores other local edits', async () => {
    const { root, advance, pull } = setup();
    const originalHead = git(root, 'rev-parse', 'HEAD');
    writeFileSync(join(root, 'local.txt'), 'current local work\n');
    writeFileSync(join(root, 'incoming.txt'), 'untracked local work\n');
    advance('incoming.txt', 'remote version\n');
    const result = await pull();
    expect(result.ok).toBe(false);
    expect(git(root, 'rev-parse', 'HEAD')).toBe(originalHead);
    expect(readFileSync(join(root, 'local.txt'), 'utf8')).toBe('current local work\n');
    expect(readFileSync(join(root, 'incoming.txt'), 'utf8')).toBe('untracked local work\n');
  }, 60_000);

  it('preserves local edits when the branch is already up to date', async () => {
    const { root, pull } = setup();
    const originalHead = git(root, 'rev-parse', 'HEAD');
    writeFileSync(join(root, 'local.txt'), 'current local work\n');
    const result = await pull();
    expect(result.ok, result.stderr).toBe(true);
    expect(git(root, 'rev-parse', 'HEAD')).toBe(originalHead);
    expect(readFileSync(join(root, 'local.txt'), 'utf8')).toBe('current local work\n');
    expect(git(root, 'stash', 'list')).toBe('');
  }, 60_000);
});
