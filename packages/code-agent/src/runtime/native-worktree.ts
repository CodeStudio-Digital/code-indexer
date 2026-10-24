import { randomUUID } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import type { IShellPort } from '../ports/shell-port.js';
import type { PreparedWorkspaceInput } from './prepared-workspace.js';
import { ensureManagedWorktreeRoot } from './managed-worktree-root.js';

const MANAGED_ROOT = '.mcp-indexer/worktrees';
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Git runs through a product-owned, contained shell port. A failed or missing
 * worktree never silently changes the selected attempt back to the main tree. */
export async function prepareNativeWorktree(input: PreparedWorkspaceInput, shell: IShellPort): Promise<string> {
  const project = await realpath(input.projectRoot);
  input.signal?.throwIfAborted();
  await assertProjectRoot(project, shell, input.signal);
  if (input.existingPath) return verifyNativeWorktree(project, input.existingPath, shell, input.signal);
  if (!input.requested) throw new Error('Native worktree creation requires a session request');
  const name = input.requested.name?.trim() || `wt-${randomUUID().slice(0, 12)}`;
  if (!NAME.test(name) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) throw new Error('Invalid worktree name');
  const branch = input.requested.branch?.trim() || `coder/${name}`;
  await git(shell, project, ['check-ref-format', '--branch', branch], input.signal);
  const managed = await ensureManagedWorktreeRoot(project);
  const path = resolve(managed, name);
  try { await stat(path); throw new Error(`Worktree path already exists: ${path}`); }
  catch (cause) { if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause; }
  const existing = await shell.run('git', ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`],
    { cwd: project, timeoutMs: 30_000, signal: input.signal, maxOutputBytes: 64 * 1024 });
  input.signal?.throwIfAborted();
  if (existing.exitCode !== 0 && existing.exitCode !== 1) throw new Error('Unable to inspect the requested worktree branch');
  await git(shell, project, existing.exitCode === 0 ? ['worktree', 'add', '--', path, branch]
    : ['worktree', 'add', '-b', branch, '--', path], input.signal);
  const verified = await verifyNativeWorktree(project, path, shell, input.signal);
  // Preserve a created tree if persistence fails. Deletion would discard work
  // that Git hooks/filters may have produced; the error must remain visible.
  await input.persist(verified);
  return verified;
}

export async function verifyNativeWorktree(projectRoot: string, path: string, shell: IShellPort, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  const project = await realpath(projectRoot);
  await assertProjectRoot(project, shell, signal);
  const managed = await realpath(resolve(project, MANAGED_ROOT));
  const actual = await realpath(path);
  if (!inside(project, managed) || !inside(managed, actual)) throw new Error('Native worktree is outside its managed project root');
  const listed = await git(shell, project, ['worktree', 'list', '--porcelain', '-z'], signal);
  const registered = listed.split('\0').filter(item => item.startsWith('worktree ')).map(item => item.slice(9));
  if (!registered.some(item => equalPath(item, actual))) throw new Error('Native worktree is not registered to this project');
  const common = async (cwd: string) => realpath(resolve(cwd, (await git(shell, cwd, ['rev-parse', '--git-common-dir'], signal)).trim()));
  if (!equalPath(await common(project), await common(actual))) throw new Error('Native worktree repository ownership differs');
  return actual;
}

async function git(shell: IShellPort, cwd: string, args: string[], signal?: AbortSignal): Promise<string> {
  const result = await shell.run('git', args, { cwd, timeoutMs: 300_000, signal, maxOutputBytes: 1024 * 1024 });
  signal?.throwIfAborted();
  if (result.exitCode !== 0 || result.stdoutTruncation || result.stderrTruncation) {
    throw new Error(`Native worktree Git command failed: ${result.stderr.slice(0, 2_000) || 'cancelled, timed out or excessive output'}`);
  }
  return result.stdout;
}

function equalPath(a: string, b: string) {
  return process.platform === 'win32' ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b);
}
async function assertProjectRoot(project: string, shell: IShellPort, signal?: AbortSignal) {
  const gitRoot = await realpath((await git(shell, project, ['rev-parse', '--show-toplevel'], signal)).trim());
  if (!equalPath(project, gitRoot)) throw new Error('Native worktree requires the registered Git project root');
}
function inside(root: string, path: string) {
  const rel = relative(root, path);
  return !!rel && !isAbsolute(rel) && rel !== '..' && !rel.startsWith('../') && !rel.startsWith('..\\');
}
