import { afterAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const gitSpawnStats = vi.hoisted(() => ({ statusCalls: 0 }));

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

function makeHandlers(root: string) {
  return createProjectGitHandlers({
    db: {
      getProject: (id: number) => (id === 1 ? { id, name: 'Repo', root_path: root } : null),
    },
  } as never);
}

describe('project git status', () => {
  it('returns summary without files and without running full git status', async () => {
    const handlers = makeHandlers(await setupRepo());
    gitSpawnStats.statusCalls = 0;

    const status = await handlers.status({ projectId: 1, includeFiles: false }, {} as never);

    expect(status.branch).toBe('main');
    expect('files' in status).toBe(false);
    expect(gitSpawnStats.statusCalls).toBe(0);
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
