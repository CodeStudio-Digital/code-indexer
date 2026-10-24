import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { NativeWorktreeTransitionPort } from '../workers/native-worktree-transition-port.js';
import { applyNativeWorktreeTransition } from '../workers/native-worktree-transition-effect.js';
import type { NativeWorktreeTransition } from '@mcp/code-agent/ports/worktree-transition-port.js';
import type { ToolContext } from '@mcp/code-agent/core/tool.js';
import { enterWorktree, exitWorktree } from '@mcp/code-agent/tools/worktree.js';
import { defaultLocalShellPort, type IShellPort } from '@mcp/code-agent/ports/shell-port.js';

let directory: string; let root: string; let ordinal = 0;
const shell = defaultLocalShellPort();
const signal = new AbortController().signal;
const git = (args: string[], cwd = root) => shell.run('git', args, { cwd, timeoutMs: 10_000 });
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'native-worktree-transition-')); root = join(directory, 'project');
  await mkdir(root); expect((await git(['init', '--initial-branch=main'])).exitCode).toBe(0);
  await writeFile(join(root, 'seed.txt'), 'source'); await git(['add', 'seed.txt']);
  expect((await git(['-c', 'user.name=Harness', '-c', 'user.email=harness@example.invalid', 'commit', '-m', 'fixture'])).exitCode).toBe(0);
});
afterAll(async () => {
  const target = resolve(directory);
  if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('native-worktree-transition-')) throw new Error('Unsafe fixture cleanup');
  await rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
});
async function staged(name: string, source = root, args: Record<string, unknown> = { name }): Promise<NativeWorktreeTransition> {
  const port = new NativeWorktreeTransitionPort(root, source, () => {});
  const context = { cwd: source, projectName: 'fixture', runtimeGeneration: 'rust_v1',
    currentToolUseId: `fixture-${++ordinal}`, ports: { worktree: port }, signal } satisfies ToolContext;
  const tool = source === root ? enterWorktree : exitWorktree;
  expect((await tool.handler(args, context)).isError).toBeFalsy(); return port.transition!;
}
function effect(intent: NativeWorktreeTransition, extras: Partial<Parameters<typeof applyNativeWorktreeTransition>[0]> = {}) {
  return { intent, receiptDirectory: join(directory, 'receipts'), shell, signal,
    assertCurrent: async () => {}, assertMutation() {}, provePreviousAttemptReaped: async () => {},
    persist: async (_path: string | null) => {}, ...extras };
}

it('stages a native switch without touching Git, cwd or the legacy runner', async () => {
  const port = new NativeWorktreeTransitionPort(root, root, () => {});
  const legacy = { enterWorktreeScope: vi.fn() };
  const context = { cwd: root, projectName: 'fixture', runtimeGeneration: 'rust_v1', currentToolUseId: 'stage',
    runner: legacy, ports: { worktree: port } } as unknown as ToolContext;
  expect((await enterWorktree.handler({ name: 'staged-only' }, context)).isError).toBeFalsy();
  expect(context.cwd).toBe(root); expect(legacy.enterWorktreeScope).not.toHaveBeenCalled();
  await expect(stat(join(root, '.mcp-indexer/worktrees/staged-only'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect((await enterWorktree.handler({ name: 'second' }, context)).isError).toBe(true);
});
it('never falls back to legacy cwd mutation for Rust', async () => {
  const context = { cwd: root, projectName: 'fixture', runtimeGeneration: 'rust_v1' } as ToolContext;
  expect((await enterWorktree.handler({}, context)).isError).toBe(true);
  expect((await exitWorktree.handler({ action: 'keep' }, context)).isError).toBe(true);
});
it.each([{ name: '../escape' }, { name: 'CON' }, { branch: '-unsafe' }, { branch: 'has space' }, { name: false }])('rejects malformed native intent %j', async args => {
  const port = new NativeWorktreeTransitionPort(root, root, () => {});
  const context = { cwd: root, projectName: 'fixture', currentToolUseId: 'invalid' } as ToolContext;
  expect((await port.request('enter_worktree', args, context)).isError).toBe(true); expect(port.transition).toBeUndefined();
});
it('requires old physical reap before any Git', async () => {
  const intent = await staged('unreaped'); const run = vi.fn();
  await expect(applyNativeWorktreeTransition(effect(intent, { shell: { ...shell, run } as IShellPort,
    provePreviousAttemptReaped: async () => { throw new Error('old process alive'); } }))).rejects.toThrow('old process alive');
  expect(run).not.toHaveBeenCalled();
});
it('creates a worktree once and restores metadata from a confirmed receipt after a persistence failure', async () => {
  const intent = await staged('confirmed'); let failed = false; let created = 0;
  const port: IShellPort = { ...shell, run: async (command, args, opts) => { if (args[0] === 'worktree' && args[1] === 'add') created++; return shell.run(command, args, opts); } };
  await expect(applyNativeWorktreeTransition(effect(intent, { shell: port, persist: async () => { failed = true; throw new Error('metadata disk full'); } }))).rejects.toThrow('metadata disk full');
  expect(failed).toBe(true);
  let persisted: string | null = null;
  const cwd = await applyNativeWorktreeTransition(effect(intent, { shell: port, persist: async value => { persisted = value; } }));
  expect(persisted).toBe(cwd); expect(created).toBe(1); expect(await readFile(join(cwd, 'seed.txt'), 'utf8')).toBe('source');
  expect((await git(['branch', '--show-current'])).stdout.trim()).toBe('main');
});
it('fences an executed Git mutation whose ACK is lost instead of replaying it', async () => {
  const intent = await staged('lost-ack'); let creations = 0;
  const port: IShellPort = { ...shell, run: async (command, args, opts) => {
    const result = await shell.run(command, args, opts);
    if (args[0] === 'worktree' && args[1] === 'add') { creations++; throw new Error('ACK lost after Git finished'); }
    return result;
  } };
  await expect(applyNativeWorktreeTransition(effect(intent, { shell: port }))).rejects.toMatchObject({ effectOutcome: 'unknown' });
  expect(await readFile(join(root, '.mcp-indexer/worktrees/lost-ack/seed.txt'), 'utf8')).toBe('source');
  await expect(applyNativeWorktreeTransition(effect(intent, { shell: port }))).rejects.toMatchObject({ code: 'TOOL_OUTCOME_UNKNOWN' });
  expect(creations).toBe(1);
});
it('retains the uncertainty fence when a previous transition receipt is corrupt', async () => {
  const intent = await staged('corrupt-receipt');
  await mkdir(join(directory, 'receipts'), { recursive: true });
  await writeFile(join(directory, 'receipts', `${intent.id}.json`), '{"phase":"started"');
  const run = vi.fn();
  await expect(applyNativeWorktreeTransition(effect(intent, { shell: { ...shell, run } as IShellPort })))
    .rejects.toMatchObject({ code: 'TOOL_OUTCOME_UNKNOWN', effectOutcome: 'unknown' });
  expect(run).not.toHaveBeenCalled();
});
it('preserves dirty files and unmerged commits without explicit discard', async () => {
  const entered = await applyNativeWorktreeTransition(effect(await staged('preserve')));
  await writeFile(join(entered, 'keep.txt'), 'user work');
  const dirty = await staged('', entered, { action: 'remove' });
  await expect(applyNativeWorktreeTransition(effect(dirty))).rejects.toThrow('uncommitted');
  await git(['add', 'keep.txt'], entered);
  await git(['-c', 'user.name=Harness', '-c', 'user.email=harness@example.invalid', 'commit', '-m', 'unmerged work'], entered);
  const ahead = await staged('', entered, { action: 'remove' });
  await expect(applyNativeWorktreeTransition(effect(ahead))).rejects.toThrow('commits absent');
  expect(await readFile(join(entered, 'keep.txt'), 'utf8')).toBe('user work');
  let persisted: string | null | undefined;
  await applyNativeWorktreeTransition(effect(await staged('', entered, { action: 'keep' }), { persist: async value => { persisted = value; } }));
  expect(persisted).toBeNull(); expect(await readFile(join(entered, 'keep.txt'), 'utf8')).toBe('user work');
});
it('removes only its registered managed tree and reopens the confirmed removal without another mutation', async () => {
  const cwd = await applyNativeWorktreeTransition(effect(await staged('remove')));
  await writeFile(join(cwd, 'discard.txt'), 'explicitly discarded');
  const intent = await staged('', cwd, { action: 'remove', discard_changes: true }); let removals = 0;
  const port: IShellPort = { ...shell, run: async (command, args, opts) => { if (args[0] === 'worktree' && args[1] === 'remove') removals++; return shell.run(command, args, opts); } };
  expect(await applyNativeWorktreeTransition(effect(intent, { shell: port }))).toBe(await import('node:fs/promises').then(fs => fs.realpath(root)));
  await applyNativeWorktreeTransition(effect(intent, { shell: port })); expect(removals).toBe(1);
  await expect(stat(cwd)).rejects.toMatchObject({ code: 'ENOENT' });
});
