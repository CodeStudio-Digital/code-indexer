import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunnerStartInput } from '@mcp/api-bus';
import { createContext } from '@mcp/api-handlers/context.js';
import { createRunnerHandlers } from '@mcp/api-handlers/runner/index.js';
import { sharedPtyManager, type PtyEntry } from '@mcp/api-handlers/terminal/pty-manager.js';
import { resolveProjectWorktree } from '@mcp/code-agent/tools/project-worktrees.js';

let tempRoot: string;
let fixture: string;
let main: string;
let worktree: string;
const projectId = 7;
const context = createContext();
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, windowsHide: true, stdio: 'pipe' });
const unusedPtyEntry = {} as PtyEntry;

vi.mock('@mcp/shared/utils/config.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('@mcp/shared/utils/config.js')>(),
  ensureDataDir: () => fixture,
}));

beforeEach(async () => {
  tempRoot = await realpath(tmpdir());
  fixture = await mkdtemp(join(tempRoot, 'codestudio-runner-worktrees-'));
  main = join(fixture, 'main');
  worktree = join(fixture, 'feature checkout');
  await mkdir(main);
  git(main, 'init', '-b', 'main');
  git(main, '-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '--allow-empty', '-m', 'Initial');
  git(main, 'worktree', 'add', '-b', 'feature', worktree);
  await writeFile(join(main, 'package.json'), JSON.stringify({ scripts: { 'main-only': 'echo main' } }));
  await writeFile(join(worktree, 'package.json'), JSON.stringify({ scripts: { 'feature-only': 'echo feature' } }));
  await mkdir(join(worktree, 'backend'));
  await writeFile(join(worktree, 'backend', 'composer.json'), JSON.stringify({ scripts: { check: 'echo feature backend' } }));
});

afterEach(async () => {
  vi.restoreAllMocks();
  const path = await realpath(fixture);
  if (dirname(path) !== tempRoot || path !== fixture) throw new Error('Unexpected fixture location');
  await rm(path, { recursive: true, force: true });
});

function handlers() {
  const getProject = () => ({ id: projectId, name: 'Fixture', root_path: main });
  const db = { getProject, getProjectAsync: async () => getProject(), getProjectCatalogEntry: getProject };
  return createRunnerHandlers({ db: db as unknown as Parameters<typeof createRunnerHandlers>[0]['db'], resolveProjectWorktree });
}

describe('runner checkout scope', () => {
  it('discovers scripts in the chosen checkout and starts and restarts in its nested manifest directory', async () => {
    let terminal = 0;
    const spawn = vi.spyOn(sharedPtyManager, 'spawn').mockImplementation(() => ({ id: `test-pty-${++terminal}`, entry: unusedPtyEntry }));
    const release = vi.spyOn(sharedPtyManager, 'release').mockImplementation(() => undefined);
    const runner = handlers();
    const mainDetection = await runner.detect({ projectId }, context);
    expect(mainDetection.groups.flatMap(group => group.runners.map(cmd => cmd.label))).toEqual(['main-only']);

    const scoped = await runner.detect({ projectId, worktreePath: worktree }, context);
    expect(scoped.groups.flatMap(group => group.runners.map(cmd => cmd.label))).toEqual(['feature-only', 'check']);
    const composer = scoped.groups.find(group => group.manager === 'composer')!;
    const { label, command, manager } = composer.runners[0]!;
    const mainRun = await runner.start({ projectId, label: 'main-only', command: 'npm run main-only', manager: 'npm' }, context);
    const featureRun = await runner.start({ projectId, worktreePath: worktree, cwd: composer.cwd, label, command, manager }, context);
    expect(mainRun.worktreePath).toBeUndefined();
    expect(featureRun.worktreePath).toBe(await realpath(worktree));
    expect(spawn.mock.calls.map(([options]) => options.cwd)).toEqual([main, join(worktree, 'backend')]);

    const restarted = await runner.restart({ taskId: featureRun.taskId }, context);
    expect(release).toHaveBeenCalledExactlyOnceWith(featureRun.terminalId);
    expect(spawn.mock.lastCall?.[0].cwd).toBe(join(worktree, 'backend'));
    expect(restarted).toMatchObject({ worktreePath: featureRun.worktreePath, cwd: 'backend' });
    expect((await runner.list({}, context)).map(run => run.taskId)).toEqual([mainRun.taskId, restarted.taskId]);
  });

  it('rejects paths outside the repository and preserves the retained run when its checkout is unavailable', async () => {
    const spawn = vi.spyOn(sharedPtyManager, 'spawn').mockReturnValue({ id: 'test-pty', entry: unusedPtyEntry });
    const release = vi.spyOn(sharedPtyManager, 'release').mockImplementation(() => undefined);
    const runner = handlers();
    const input: RunnerStartInput = { projectId, worktreePath: worktree, command: 'npm run feature-only', label: 'feature-only', manager: 'npm' };
    await expect(runner.detect({ projectId, worktreePath: fixture }, context)).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(runner.start({ ...input, worktreePath: fixture }, context)).rejects.toMatchObject({ code: 'invalid_input' });
    expect(spawn).not.toHaveBeenCalled();

    const run = await runner.start(input, context);
    await unlink(join(worktree, '.git'));
    await expect(runner.restart({ taskId: run.taskId }, context)).rejects.toMatchObject({ code: 'invalid_input' });
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(release).not.toHaveBeenCalled();
    expect(await runner.list({}, context)).toEqual([run]);
  });
});
