import { afterAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const gitSpawnStats = vi.hoisted(() => ({ statusCalls: 0 }));

vi.mock('../git-read-runner.js', async () => {
  const actual = await vi.importActual<typeof import('../git-read-runner.js')>('../git-read-runner.js');
  return { ...actual, runGitRead(input: Parameters<typeof actual.runGitRead>[0]) {
    if (input.args[0] === 'status') gitSpawnStats.statusCalls++;
    return actual.runGitRead(input);
  } };
});

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return {
    ...actual,
    spawn(command: string, args?: readonly string[], options?: unknown) {
      if (command === 'git' && Array.isArray(args) && args[0] === 'status') {
        gitSpawnStats.statusCalls += 1;
      }
      return actual.spawn(command, args, options as never);
    },
  };
});

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const { createProjectGitHandlers } = await import('../index.js');

const dirs: string[] = [];

afterAll(() => {
  for (const dir of dirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best effort cleanup
    }
  }
});

async function runGit(cwd: string, args: string[]): Promise<void> {
  const { spawn } = await import('node:child_process');
  await new Promise<void>((resolve, reject) => {
    const child = spawn('git', args, { cwd, windowsHide: true });
    const err: Buffer[] = [];
    child.stderr.on('data', (chunk: Buffer) => err.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(Buffer.concat(err).toString('utf8') || `git ${args.join(' ')} failed`));
    });
    child.stdin.end();
  });
}

async function setupRepo(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-git-status-'));
  dirs.push(dir);
  await runGit(dir, ['init', '-b', 'main']);
  await runGit(dir, ['config', 'user.email', 't@example.com']);
  await runGit(dir, ['config', 'user.name', 'Tester']);
  await runGit(dir, ['config', 'commit.gpgsign', 'false']);
  writeFileSync(join(dir, 'tracked.txt'), 'base\n');
  await runGit(dir, ['add', '.']);
  await runGit(dir, ['commit', '-m', 'base']);
  writeFileSync(join(dir, 'tracked.txt'), 'base\nmodified\n');
  writeFileSync(join(dir, 'staged.txt'), 'staged\n');
  await runGit(dir, ['add', 'staged.txt']);
  writeFileSync(join(dir, 'untracked.txt'), 'new\n');
  return dir;
}

/** Main repo with a working change + a submodule (its own committed-then-
 *  modified file) declared in .gitmodules — for the aggregate-status path. */
async function setupRepoWithSubmodule(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-git-agg-'));
  dirs.push(dir);
  const init = async (d: string) => {
    await runGit(d, ['init', '-b', 'main']);
    await runGit(d, ['config', 'user.email', 't@example.com']);
    await runGit(d, ['config', 'user.name', 'Tester']);
    await runGit(d, ['config', 'commit.gpgsign', 'false']);
  };
  await init(dir);
  writeFileSync(join(dir, 'root.txt'), 'base\n');
  await runGit(dir, ['add', '.']);
  await runGit(dir, ['commit', '-m', 'base']);
  writeFileSync(join(dir, 'root.txt'), 'base\nmod\n'); // main working change

  const subDir = join(dir, 'packages', 'sub');
  mkdirSync(subDir, { recursive: true });
  await init(subDir);
  writeFileSync(join(subDir, 'inner.txt'), 'a\n');
  await runGit(subDir, ['add', '.']);
  await runGit(subDir, ['commit', '-m', 'sub base']);
  writeFileSync(join(subDir, 'inner.txt'), 'a\nb\n'); // submodule working change

  writeFileSync(join(dir, '.gitmodules'), '[submodule "sub"]\n\tpath = packages/sub\n\turl = ./x\n');
  return dir;
}

function makeHandlers(root: string) {
  return createProjectGitHandlers({
    db: {
      getProjectRootPath: (id: number) => (id === 1 ? root : undefined),
    },
  } as never);
}

describe('project git status', () => {
  it('reads the catalog root without loading the full project overlays', async () => {
    const root = await setupRepo();
    const getProject = vi.fn(() => {
      throw new Error('full project lookup must not run');
    });
    const handlers = createProjectGitHandlers({
      db: {
        getProjectRootPath: (id: number) => (id === 1 ? root : undefined),
        getProject,
      },
    } as never);

    const status = await handlers.status({ projectId: 1, includeFiles: false }, {} as never);

    expect(status.branch).toBe('main');
    expect(getProject).not.toHaveBeenCalled();
  });

  it('returns summary without files using one git status process', async () => {
    const handlers = makeHandlers(await setupRepo());
    gitSpawnStats.statusCalls = 0;

    const status = await handlers.status({ projectId: 1, includeFiles: false }, {} as never);

    expect(status.branch).toBe('main');
    expect('files' in status).toBe(false);
    expect(gitSpawnStats.statusCalls).toBe(1);
  });

  it('parses full porcelain v2 status with a single git status call', async () => {
    const handlers = makeHandlers(await setupRepo());
    gitSpawnStats.statusCalls = 0;

    const status = await handlers.status({ projectId: 1, includeFiles: true }, {} as never);

    expect(gitSpawnStats.statusCalls).toBe(1);
    expect(status.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'tracked.txt', state: 'modified', staged: false }),
        expect.objectContaining({ path: 'staged.txt', state: 'added', staged: true }),
        expect.objectContaining({ path: 'untracked.txt', state: 'untracked', staged: false }),
      ]),
    );
  });

  it('aggregates status across submodules, rebasing paths + suppressing the gitlink', async () => {
    const handlers = makeHandlers(await setupRepoWithSubmodule());

    const status = await handlers.status({ projectId: 1, includeFiles: true }, {} as never);
    const paths = (status.files ?? []).map((f) => f.path);

    // The submodule's internal change shows project-relative + tagged with its repo.
    expect(status.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'packages/sub/inner.txt', state: 'modified', repo: 'packages/sub' }),
      ]),
    );
    // The main repo's own change is present (project-relative, untagged).
    expect(paths).toContain('root.txt');
    // The parent's single opaque entry for the submodule dir is suppressed.
    expect(paths).not.toContain('packages/sub');
    expect(paths).not.toContain('packages/sub/');
  });

  it('routes a submodule file baseline to the submodule HEAD, not the parent', async () => {
    const handlers = makeHandlers(await setupRepoWithSubmodule());

    // No repoPath → auto-route by path. The committed content lives in the
    // SUBMODULE's HEAD; the parent only has an opaque gitlink, so a broken
    // router would return null (whole file painted as added).
    const r = await handlers.baseline({ projectId: 1, path: 'packages/sub/inner.txt' }, {} as never);
    expect(r.isRepo).toBe(true);
    expect(r.content).toBe('a\n');
  });

  it('routes staging a submodule file to the submodule (no repoPath)', async () => {
    const handlers = makeHandlers(await setupRepoWithSubmodule());

    await handlers.stage({ projectId: 1, paths: ['packages/sub/inner.txt'] }, {} as never);

    const status = await handlers.status({ projectId: 1, includeFiles: true }, {} as never);
    const staged = (status.files ?? []).find((f) => f.path === 'packages/sub/inner.txt' && f.staged);
    expect(staged).toBeTruthy();
  });

  it('shares concurrent full status calls for the same project', async () => {
    const handlers = makeHandlers(await setupRepo());
    gitSpawnStats.statusCalls = 0;

    await Promise.all([
      handlers.status({ projectId: 1, includeFiles: true }, {} as never),
      handlers.status({ projectId: 1, includeFiles: true }, {} as never),
    ]);

    expect(gitSpawnStats.statusCalls).toBe(1);
  });
});
