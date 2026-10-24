import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getDiagnostics } from '../diagnostics.js';
import { ToolRegistry } from '../../core/registry.js';
import { createMutationFenceAuthority } from '../../core/mutation-fence.js';
import type { ToolContext } from '../../core/tool.js';
import type { IShellPort, ShellExecResult } from '../../ports/shell-port.js';
import type { IFilesystemPort } from '../../ports/filesystem-port.js';

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'diagnostics-owned-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
const success = (): ShellExecResult => ({ stdout: '', stderr: '', exitCode: 0, timedOut: false });
function setup(run = vi.fn(async () => success())) {
  const shell = { mutationFenceAttested: true, run } as unknown as IShellPort;
  const context: ToolContext = { cwd: root, projectName: 'test', ports: { shell } };
  return { shell, context, run };
}

it('resolves workspace compilers with POSIX paths in a sandbox even on Windows', async () => {
  const { context, run } = setup(); context.cwd = '/workspace/project';
  const stat = vi.fn(async (path: string) => {
    if (path === '/workspace/project/a.ts' || path === '/workspace/node_modules/typescript/bin/tsc') return { isFile: () => true };
    throw Object.assign(new Error('missing'), { code: 'ENOENT' });
  });
  context.ports!.fs = { stat } as unknown as IFilesystemPort;
  expect((await getDiagnostics.handler({ file_path: 'a.ts' }, context)).isError).toBe(false);
  expect(run).toHaveBeenCalledWith('node', ['/workspace/node_modules/typescript/bin/tsc', '--noEmit', '--pretty', 'false'], expect.objectContaining({ cwd: '/workspace/project' }));
  expect(stat.mock.calls.every(([path]) => !path.includes('\\'))).toBe(true);
});

it('rechecks project dependencies without the stale single-file mtime cache', async () => {
  await mkdir(join(root, 'node_modules/typescript/bin'), { recursive: true });
  await writeFile(join(root, 'node_modules/typescript/bin/tsc'), '// fixture');
  await writeFile(join(root, 'a.ts'), 'import { value } from "./b";');
  const { context, run } = setup();
  await getDiagnostics.handler({ file_path: 'a.ts' }, context);
  await writeFile(join(root, 'b.ts'), 'export const value = "changed";');
  await getDiagnostics.handler({ file_path: 'a.ts' }, context);
  expect(run).toHaveBeenCalledTimes(2);
  expect(run).toHaveBeenCalledWith('node', [join(root, 'node_modules/typescript/bin/tsc'), '--noEmit', '--pretty', 'false'], expect.objectContaining({ timeoutMs: 60000, maxOutputBytes: 100000 }));
});

it('never downloads a missing TypeScript compiler or invokes a command shell', async () => {
  await writeFile(join(root, 'a.ts'), 'const a = 1'); const { context, run } = setup();
  const result = await getDiagnostics.handler({ file_path: 'a.ts' }, context);
  expect(result.isError).toBe(true); expect(result.content).toContain('No project TypeScript'); expect(run).not.toHaveBeenCalled();
});

it('propagates cancellation and waits for the owned process to finish cleanup', async () => {
  await writeFile(join(root, 'a.rs'), 'fn main() {}');
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const drained = new Promise<void>(resolve => { release = resolve; });
  const run = vi.fn(async (_program: string, _args: string[], opts: { signal?: AbortSignal }) => {
    entered(); await new Promise<void>(resolve => opts.signal!.addEventListener('abort', () => resolve(), { once: true }));
    await drained; return { ...success(), exitCode: null };
  });
  const { context } = setup(run as ReturnType<typeof setup>['run']); const ctrl = new AbortController(); context.signal = ctrl.signal;
  let settled = false; const result = getDiagnostics.handler({ file_path: 'a.rs' }, context).finally(() => { settled = true; });
  await started; ctrl.abort(new Error('cancelled by user')); await new Promise(resolve => setTimeout(resolve, 10));
  expect(settled).toBe(false); release(); expect((await result).content).toContain('cancelled by user');
});

it('falls back to non-importing Python syntax parsing only when ruff is missing', async () => {
  await writeFile(join(root, 'a.py'), 'print("do not execute")');
  const { context, run } = setup(); run.mockResolvedValueOnce({ ...success(), exitCode: null, stderr: 'spawn ruff ENOENT' });
  expect((await getDiagnostics.handler({ file_path: 'a.py' }, context)).isError).toBe(false);
  expect(run).toHaveBeenNthCalledWith(2, 'python', expect.arrayContaining(['-I', '-B', '-c', expect.stringContaining('ast.parse')]), expect.any(Object));
  run.mockClear(); run.mockResolvedValueOnce({ ...success(), exitCode: null, timedOut: true });
  expect((await getDiagnostics.handler({ file_path: 'a.py' }, context)).isError).toBe(true); expect(run).toHaveBeenCalledTimes(1);
});

it('does not mistake failed or truncated compiler output for a clean file', async () => {
  await writeFile(join(root, 'a.php'), '<?php'); const { context, run } = setup();
  run.mockResolvedValueOnce({ ...success(), exitCode: null, stderr: 'spawn php ENOENT' });
  expect((await getDiagnostics.handler({ file_path: 'a.php' }, context)).isError).toBe(true);
  run.mockResolvedValueOnce({ ...success(), exitCode: 1, stdout: 'head [truncated] tail', stdoutTruncation: { inputBytes: 900000, outputBytes: 100000 } });
  const result = await getDiagnostics.handler({ file_path: 'a.php' }, context);
  expect(result.isError).toBe(true); expect(result.sourceTruncations).toEqual([expect.objectContaining({ inputSize: 900000, recoverable: false })]);
});

it('binds only the language-specific checker and revalidates ownership before spawn', async () => {
  await writeFile(join(root, 'a.php'), '<?php'); const { context, run } = setup();
  let owned = true;
  const fence = createMutationFenceAuthority({ mode: 'enforce', authorizedRoot: root, assertLease: () => { if (!owned) throw new Error('lease lost'); },
    snapshot: () => ({ environmentId: 'env:test', environmentVersion: 1 }) });
  const registry = new ToolRegistry(); registry.register(getDiagnostics); context.mutationFence = fence;
  expect((await registry.invoke('get_diagnostics', { file_path: 'a.php' }, context)).isError).toBe(false);
  expect(run).toHaveBeenCalledTimes(1); owned = false;
  expect((await registry.invoke('get_diagnostics', { file_path: 'a.php' }, context)).isError).toBe(true);
  expect(run).toHaveBeenCalledTimes(1);
  const other = createMutationFenceAuthority({ mode: 'enforce', authorizedRoot: root, assertLease: () => {}, snapshot: () => ({ environmentId: 'env:other', environmentVersion: 1 }) });
  const invocation = other.bindInvocation({ toolName: 'get_diagnostics', toolUseId: 'test', effectiveInput: { file_path: 'a.php' }, boundary: 'shell', requiresEffectBoundary: true });
  expect(() => invocation.assertMutation({ kind: 'shell', operation: 'run', resource: 'python' })).toThrow();
});
