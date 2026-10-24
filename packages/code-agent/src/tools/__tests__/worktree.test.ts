import { beforeAll, afterAll, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { defaultLocalShellPort, type IShellPort } from '../../ports/shell-port.js';
import type { ToolContext } from '../../core/tool.js';
import { createProjectWorktree, enterWorktree, exitWorktree } from '../worktree.js';

const shell = defaultLocalShellPort();
let fixture: string; let root: string;
const git = (args: string[], cwd = root) => shell.run('git', args, { cwd, timeoutMs: 10_000 });
beforeAll(async () => {
  fixture = await mkdtemp(join(tmpdir(), 'worktree-async-test-')); root = join(fixture, 'project');
  await mkdir(root);
  expect((await git(['init', '--initial-branch=main'])).exitCode).toBe(0);
  expect((await git(['config', 'core.autocrlf', 'false'])).exitCode).toBe(0);
  await writeFile(join(root, 'seed.txt'), 'seed\n'); await git(['add', 'seed.txt']);
  expect((await git(['-c', 'user.name=Harness', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'fixture'])).exitCode).toBe(0);
});
afterAll(async () => {
  const target = resolve(fixture);
  if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('worktree-async-test-')) throw new Error('Unsafe fixture cleanup');
  await rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
});
function context(port = shell) {
  const ctx = { cwd: root, projectName: 'worktree-test', ports: { shell: port } } as ToolContext;
  const runner = { originalCwd: root, worktreePath: null as string | null,
    enterWorktreeScope: vi.fn((path: string) => { runner.worktreePath = path; ctx.cwd = path; }),
    exitWorktreeScope: vi.fn(() => { runner.worktreePath = null; ctx.cwd = root; }) };
  ctx.runner = runner as unknown as ToolContext['runner'];
  return { ctx, runner };
}
function port(run: IShellPort['run']): IShellPort { return { run, exec: shell.exec.bind(shell), spawn: shell.spawn.bind(shell) }; }

it('rejects a junction before creating any child outside the project', async () => {
  const engine = 'typescript';
  const project = join(fixture, `junction-${engine}`);
  const outside = join(fixture, `outside-${engine}`);
  await mkdir(project); await mkdir(outside);
  await symlink(outside, join(project, '.mcp-indexer'), process.platform === 'win32' ? 'junction' : 'dir');
  const canonical = await realpath(project);
  const run = vi.fn<IShellPort['run']>(async (_command, args) => ({
    stdout: args[1] === '--show-toplevel' ? canonical : 'true', stderr: '', exitCode: 0, timedOut: false,
  }));
  expect(await createProjectWorktree(project, { name: 'escape' }, { shell: port(run) }))
    .toMatchObject({ ok: false, error: expect.stringContaining('escapes') });
  await expect(stat(join(outside, 'worktrees'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(run.mock.calls.every(([, args]) => args[0] !== 'worktree')).toBe(true);
});

it('creates, scopes and removes a real worktree without changing the main branch', async () => {
  const { ctx, runner } = context();
  expect((await enterWorktree.handler({ name: 'clean', branch: 'codex/clean' }, ctx)).isError).toBeFalsy();
  const path = ctx.cwd;
  expect(await readFile(join(path, 'seed.txt'), 'utf8')).toBe('seed\n');
  expect((await git(['branch', '--show-current'])).stdout.trim()).toBe('main');
  expect((await exitWorktree.handler({ action: 'remove' }, ctx)).isError).toBeFalsy();
  expect(ctx.cwd).toBe(root); expect(runner.exitWorktreeScope).toHaveBeenCalledOnce();
  await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' });
});
it('preserves dirty files unless discard is explicitly boolean true', async () => {
  const { ctx, runner } = context();
  await enterWorktree.handler({ name: 'dirty' }, ctx);
  const path = ctx.cwd; await writeFile(join(path, 'uncommitted.txt'), 'keep');
  expect((await exitWorktree.handler({ action: 'remove' }, ctx)).isError).toBe(true);
  expect((await exitWorktree.handler({ action: 'remove', discard_changes: 'false' }, ctx)).isError).toBe(true);
  expect(runner.exitWorktreeScope).not.toHaveBeenCalled();
  expect(await readFile(join(path, 'uncommitted.txt'), 'utf8')).toBe('keep');
  expect((await exitWorktree.handler({ action: 'keep' }, ctx)).isError).toBeFalsy();
  expect(await readFile(join(path, 'uncommitted.txt'), 'utf8')).toBe('keep');
});
it('does not leave scope or remove a worktree when status inspection fails', async () => {
  const created = await createProjectWorktree(root, { name: 'status-failed' });
  if (!created.ok) throw new Error(created.error);
  const run = vi.fn<IShellPort['run']>(async () => ({ stdout: '', stderr: 'index locked', exitCode: 128, timedOut: false }));
  const { ctx, runner } = context(port(run)); runner.worktreePath = created.path; ctx.cwd = created.path;
  expect((await exitWorktree.handler({ action: 'remove', discard_changes: true }, ctx)).content).toContain('removal was not attempted');
  expect(run).toHaveBeenCalledOnce(); expect(run.mock.calls[0]?.[1]).toEqual(['status', '--porcelain']);
  expect(runner.exitWorktreeScope).not.toHaveBeenCalled();
});
it('rejects removal outside the managed root before any Git dispatch', async () => {
  const foreign = join(fixture, 'foreign'); await mkdir(foreign);
  const run = vi.fn<IShellPort['run']>(); const { ctx, runner } = context(port(run));
  runner.worktreePath = foreign;
  expect((await exitWorktree.handler({ action: 'remove', discard_changes: true }, ctx)).isError).toBe(true);
  expect(run).not.toHaveBeenCalled(); expect(runner.exitWorktreeScope).not.toHaveBeenCalled();
});
it('does not dispatch a cancelled creation', async () => {
  const run = vi.fn<IShellPort['run']>(); const controller = new AbortController(); controller.abort(new Error('fixture cancellation'));
  await expect(createProjectWorktree(root, { name: 'cancelled' }, { shell: port(run), signal: controller.signal })).rejects.toThrow('fixture cancellation');
  expect(run).not.toHaveBeenCalled();
});
it.each(['../escape', 'CON', 'nul.txt', 'a/b'])('rejects an invalid managed name %s before Git', async name => {
  const run = vi.fn<IShellPort['run']>();
  expect(await createProjectWorktree(root, { name }, { shell: port(run) })).toMatchObject({ ok: false });
  expect(run).not.toHaveBeenCalled();
});
it('yields while Git is running and retains its abort signal', async () => {
  let release!: () => void; const barrier = new Promise<void>(resolve => { release = resolve; });
  const controller = new AbortController(); let first = true;
  const run = vi.fn<IShellPort['run']>(async (command, args, options) => {
    expect(options.signal).toBe(controller.signal);
    if (first) { first = false; await barrier; }
    return shell.run(command, args, options);
  });
  const creating = createProjectWorktree(root, { name: 'async' }, { shell: port(run), signal: controller.signal });
  let timerRan = false;
  await new Promise<void>(resolve => setTimeout(() => { timerRan = true; release(); resolve(); }, 10));
  expect(timerRan).toBe(true); expect(await creating).toMatchObject({ ok: true });
});
it('keeps a physically created worktree and reports unknown when its ACK is lost', async () => {
  let effects = 0;
  const run: IShellPort['run'] = async (command, args, options) => {
    const result = await shell.run(command, args, options);
    if (args[0] === 'worktree' && args[1] === 'add') {
      expect(result.exitCode).toBe(0); effects++;
      return { stdout: '', stderr: '', exitCode: null, timedOut: true };
    }
    return result;
  };
  const { ctx, runner } = context(port(run));
  const result = await enterWorktree.handler({ name: 'ack-lost' }, ctx);
  expect(result).toMatchObject({ isError: true, effectOutcome: 'unknown' });
  expect(effects).toBe(1); expect(runner.enterWorktreeScope).not.toHaveBeenCalled();
  expect(await readFile(join(root, '.mcp-indexer/worktrees/ack-lost/seed.txt'), 'utf8')).toBe('seed\n');
});
