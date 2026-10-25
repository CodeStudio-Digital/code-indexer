import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createProjectWorktree } from '../worktree-operations.js';
import { listProjectWorktrees, parseWorktrees, resolveProjectWorktree } from '../project-worktrees.js';

let root: string;
let repo: string;
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'codestudio-worktrees-'));
  repo = join(root, 'project with spaces');
  await mkdir(repo);
  git(repo, 'init', '-b', 'main');
  git(repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '--allow-empty', '-m', 'initial');
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe('project worktree inventory and authority', () => {
  it('creates a real isolated checkout, lists it and keeps uncommitted files in main', async () => {
    await writeFile(join(repo, 'uncommitted.txt'), 'main only');
    const result = await createProjectWorktree(repo, { name: 'feature', branch: 'codex/feature' });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(git(result.path, 'branch', '--show-current')).toBe('codex/feature');
    await expect(readFile(join(result.path, 'uncommitted.txt'))).rejects.toThrow();
    const inventory = await listProjectWorktrees(repo);
    expect(inventory.isGit).toBe(true);
    expect(inventory.worktrees).toHaveLength(2);
    expect(inventory.worktrees.find(item => item.primary)?.branch).toBe('main');
    expect(await resolveProjectWorktree(repo, result.path)).toBe(result.path);
    expect(await resolveProjectWorktree(repo, repo)).toBeNull();
    // A second session may reuse the exact checkout without another git add.
    expect(await resolveProjectWorktree(repo, result.path)).toBe(result.path);
  });

  it('lists external worktrees including locked checkouts and rejects unrelated directories', async () => {
    const external = join(root, 'external ç checkout');
    git(repo, 'worktree', 'add', '-b', 'external', external);
    git(repo, 'worktree', 'lock', '--reason', 'keep', external);
    expect((await listProjectWorktrees(repo)).worktrees.find(item => item.branch === 'external')).toMatchObject({ locked: true, primary: false });
    expect(await resolveProjectWorktree(repo, external)).toBe(external);
    await expect(resolveProjectWorktree(repo, root)).rejects.toThrow('does not belong');
    await expect(resolveProjectWorktree(repo, { path: external })).rejects.toThrow('non-empty');
  });

  it('reports non-Git projects and rejects deleted worktrees without changing main', async () => {
    expect(await listProjectWorktrees(root, { runtimeEnv: { pathPrepend: [], extraEnv: { GIT_CEILING_DIRECTORIES: join(root, '..') } } }))
      .toEqual({ isGit: false, worktrees: [] });
    const external = join(root, 'deleted');
    git(repo, 'worktree', 'add', '-b', 'deleted', external);
    await rm(external, { recursive: true, force: true });
    await expect(resolveProjectWorktree(repo, external)).rejects.toThrow();
    expect(git(repo, 'branch', '--show-current')).toBe('main');
  });

  it('does not accept a checkout replaced with a different Git repository', async () => {
    const external = join(root, 'replaced');
    git(repo, 'worktree', 'add', '-b', 'replaced', external);
    await rm(join(external, '.git'));
    git(external, 'init', '-b', 'foreign');
    await expect(resolveProjectWorktree(repo, external)).rejects.toThrow('no longer belongs');
  });

  it('parses detached, missing and whitespace-bearing paths without unquoting', () => {
    expect(parseWorktrees('worktree /repo\0HEAD abc\0branch refs/heads/main\0\0worktree /repo other\0HEAD def\0detached\0prunable missing\0\0', '/repo'))
      .toEqual([
        { path: '/repo', head: 'abc', branch: 'main', primary: true, locked: false, prunable: false },
        { path: '/repo other', head: 'def', branch: null, primary: false, locked: false, prunable: true },
      ]);
  });
});
