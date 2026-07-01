/**
 * Multi-repo discovery + resolution tests for repos.ts — drive a REAL temp
 * filesystem with a main repo, an initialized submodule, a declared-but-not-
 * checked-out submodule, and two nested independent repos (one .gitignored).
 * No DB / no Electron; the deps mirror what index.ts injects.
 */
import { afterAll, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRepoResolver } from '../repos.js';

interface GitResult { code: number; stdout: string; stderr: string; }

function runGit(cwd: string, args: string[]): Promise<GitResult> {
  return new Promise((resolve) => {
    const child = spawn('git', args, { cwd, windowsHide: true, env: process.env });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (c: Buffer) => out.push(c));
    child.stderr.on('data', (c: Buffer) => err.push(c));
    child.on('error', (e) => resolve({ code: -1, stdout: '', stderr: (e as Error).message }));
    child.on('close', (code) =>
      resolve({ code: code ?? -1, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') }),
    );
    child.stdin.end();
  });
}

// Mirror index.ts detectRepo: one spawn yields repoRoot + absolute gitDir.
async function detectRepo(root: string) {
  const r = await runGit(root, ['rev-parse', '--show-toplevel', '--absolute-git-dir']);
  if (r.code !== 0) return { repoRoot: null, gitDir: null, notARepo: true };
  const [repoRoot = '', gitDir = ''] = r.stdout.split('\n').map((s) => s.trim());
  if (!repoRoot) return { repoRoot: null, gitDir: null, notARepo: true };
  return { repoRoot, gitDir, notARepo: false };
}

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) try { rmSync(d, { recursive: true, force: true }); } catch { /* */ } });

/** A repo with: an initialized submodule (packages/sub), a declared-but-not-
 *  checked-out submodule (libs/uninit), a nested repo (tools/local), and a
 *  .gitignored nested repo (external/clone). Returns the realpath'd root so
 *  it matches what `git rev-parse --show-toplevel` reports. */
async function setupFixture(): Promise<string> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mcp-repos-')));
  dirs.push(dir);
  await runGit(dir, ['init', '-b', 'main']);
  writeFileSync(join(dir, '.gitignore'), 'external/\n');
  // .gitmodules declares both submodules (discovery reads this, not the index).
  writeFileSync(
    join(dir, '.gitmodules'),
    '[submodule "sub"]\n\tpath = packages/sub\n\turl = ./x\n' +
      '[submodule "uninit"]\n\tpath = libs/uninit\n\turl = ./y\n',
  );
  // Initialized submodule: a real .git makes discovery mark it initialized.
  mkdirSync(join(dir, 'packages', 'sub'), { recursive: true });
  await runGit(join(dir, 'packages', 'sub'), ['init']);
  // Declared-but-not-checked-out submodule: dir exists, no .git.
  mkdirSync(join(dir, 'libs', 'uninit'), { recursive: true });
  // Nested independent repo (not a submodule).
  mkdirSync(join(dir, 'tools', 'local'), { recursive: true });
  await runGit(join(dir, 'tools', 'local'), ['init']);
  // Nested repo the parent .gitignores.
  mkdirSync(join(dir, 'external', 'clone'), { recursive: true });
  await runGit(join(dir, 'external', 'clone'), ['init']);
  return dir;
}

function makeResolver(root: string) {
  return createRepoResolver({ runGit, requireRoot: () => root, detectRepo });
}

describe('repos: discovery (listRepos)', () => {
  it('finds main + submodules (init state) + nested repos (ignore state)', async () => {
    const root = await setupFixture();
    const repos = await makeResolver(root).listRepos(1);
    const byPrefix = new Map(repos.map((r) => [r.projectRelPrefix, r]));

    // Main repo first, prefix '' (repo === project root).
    expect(repos[0].kind).toBe('main');
    expect(repos[0].projectRelPrefix).toBe('');

    const sub = byPrefix.get('packages/sub');
    expect(sub?.kind).toBe('submodule');
    expect(sub?.initialized).toBe(true);

    const uninit = byPrefix.get('libs/uninit');
    expect(uninit?.kind).toBe('submodule');
    expect(uninit?.initialized).toBe(false);

    const local = byPrefix.get('tools/local');
    expect(local?.kind).toBe('nested');
    expect(local?.initialized).toBe(true);
    expect(local?.ignoredByParent).toBe(false);

    const ignored = byPrefix.get('external/clone');
    expect(ignored?.kind).toBe('nested');
    expect(ignored?.ignoredByParent).toBe(true);
  });
});

describe('repos: resolveCwd', () => {
  it('returns the project root when no repoPath', async () => {
    const root = await setupFixture();
    expect(await makeResolver(root).resolveCwd(1)).toBe(root);
  });

  it('returns a discovered repo abs path for a valid selection', async () => {
    const root = await setupFixture();
    const r = makeResolver(root);
    const sub = (await r.listRepos(1)).find((x) => x.projectRelPrefix === 'packages/sub')!;
    expect(await r.resolveCwd(1, sub.absPath)).toBe(sub.absPath);
  });

  it('rejects a path that is not a discovered repo', async () => {
    const root = await setupFixture();
    await expect(makeResolver(root).resolveCwd(1, join(root, 'packages'))).rejects.toMatchObject({
      code: 'unknown_repo',
    });
  });

  it('rejects an escape outside the project', async () => {
    const root = await setupFixture();
    await expect(makeResolver(root).resolveCwd(1, join(root, '..', 'evil'))).rejects.toMatchObject({
      code: 'unknown_repo',
    });
  });

  it('refuses an uninitialized submodule', async () => {
    const root = await setupFixture();
    const r = makeResolver(root);
    const uninit = (await r.listRepos(1)).find((x) => x.projectRelPrefix === 'libs/uninit')!;
    await expect(r.resolveCwd(1, uninit.absPath)).rejects.toMatchObject({
      code: 'submodule_uninitialized',
    });
  });
});

describe('repos: resolveRepoForPath (auto-routing)', () => {
  it('routes a file inside a submodule to that submodule, rebased repo-relative', async () => {
    const root = await setupFixture();
    const { repo, repoRelPath } = await makeResolver(root).resolveRepoForPath(1, 'packages/sub/src/a.ts');
    expect(repo.kind).toBe('submodule');
    expect(repo.projectRelPrefix).toBe('packages/sub');
    expect(repoRelPath).toBe('src/a.ts');
  });

  it('routes a top-level file to the main repo', async () => {
    const root = await setupFixture();
    const { repo, repoRelPath } = await makeResolver(root).resolveRepoForPath(1, 'README.md');
    expect(repo.kind).toBe('main');
    expect(repoRelPath).toBe('README.md');
  });

  it('routes a nested-repo file to the nested repo', async () => {
    const root = await setupFixture();
    const { repo, repoRelPath } = await makeResolver(root).resolveRepoForPath(1, 'tools/local/x.ts');
    expect(repo.projectRelPrefix).toBe('tools/local');
    expect(repoRelPath).toBe('x.ts');
  });
});
