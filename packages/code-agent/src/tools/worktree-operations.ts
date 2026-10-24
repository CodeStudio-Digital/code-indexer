import { randomUUID } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { defaultLocalShellPort, type AgentRuntimeEnv, type IShellPort } from '../ports/shell-port.js';
import { ensureManagedWorktreeRoot } from '../runtime/managed-worktree-root.js';

export const WORKTREE_ROOT_REL = '.mcp-indexer/worktrees';
export interface WorktreeExecution { shell?: IShellPort; signal?: AbortSignal; runtimeEnv?: AgentRuntimeEnv }
type Failure = { ok: false; error: string; outcomeUnknown?: true };
type GitResult = { ok: true; out: string; exitCode: number } | Failure;

/** The shell owns and reaps its process tree. A lost mutation ACK cannot be
 * converted into an ordinary error that invites a blind retry. */
export async function worktreeGit(args: string[], cwd: string, execution: WorktreeExecution = {},
  mutation = false, allowedExitCodes: readonly number[] = [0]): Promise<GitResult> {
  execution.signal?.throwIfAborted();
  let result;
  try {
    result = await (execution.shell ?? defaultLocalShellPort()).run('git', args, {
      cwd, signal: execution.signal, runtimeEnv: execution.runtimeEnv,
      timeoutMs: 300_000, maxOutputBytes: 1024 * 1024,
    });
  } catch (cause) {
    return { ok: false, error: `Git confirmation failed: ${String(cause)}`,
      ...(mutation ? { outcomeUnknown: true as const } : {}) };
  }
  if (mutation && (result.exitCode === null || execution.signal?.aborted || result.timedOut)) {
    return { ok: false, outcomeUnknown: true, error: 'Git mutation lost confirmation. Inspect git worktree list and the directory before authorizing another mutation.' };
  }
  execution.signal?.throwIfAborted();
  if (result.exitCode === null || !allowedExitCodes.includes(result.exitCode)
    || result.stdoutTruncation || result.stderrTruncation) {
    return { ok: false, error: `git ${args[0]} failed (${result.exitCode ?? 'no exit status'}): ${result.stderr.trim().slice(0, 2000) || 'timed out or excessive output'}`,
      ...(mutation && (result.stdoutTruncation || result.stderrTruncation) ? { outcomeUnknown: true as const } : {}) };
  }
  return { ok: true, out: result.stdout.trim(), exitCode: result.exitCode };
}

export async function createProjectWorktree(projectRoot: string, options: { name?: string; branch?: string } = {},
  execution: WorktreeExecution = {}): Promise<{ ok: true; path: string; branch: string; existed: boolean } | Failure> {
  execution.signal?.throwIfAborted();
  const rawName = options.name?.trim();
  const name = rawName || `wt-${randomUUID().slice(0, 12)}`;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)
    || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) {
    return { ok: false, error: 'Invalid worktree name: use 1-64 letters, digits, dot, underscore or dash; Windows device names are reserved.' };
  }
  const branch = options.branch?.trim() || `coder/${name}`;
  if (branch.length > 1024 || branch.includes('\0')) return { ok: false, error: 'Invalid worktree branch' };
  let project: string;
  try { project = await realpath(projectRoot); }
  catch (cause) { return { ok: false, error: `Unable to resolve worktree project root: ${String(cause)}` }; }
  const repo = await worktreeGit(['rev-parse', '--is-inside-work-tree'], project, execution);
  if (!repo.ok) return repo;
  if (repo.out !== 'true') return { ok: false, error: 'Not inside a Git working tree' };
  const branchCheck = await worktreeGit(['check-ref-format', '--branch', branch], project, execution);
  if (!branchCheck.ok) return branchCheck;
  let managed: string;
  try { managed = await ensureManagedWorktreeRoot(project); }
  catch (cause) { return { ok: false, error: String(cause) }; }
  const path = join(managed, name);
  try { await stat(path); return { ok: false, error: `Worktree path already exists: ${path}` }; }
  catch (cause) { if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause; }
  const existing = await worktreeGit(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], project, execution, false, [0, 1]);
  if (!existing.ok) return existing;
  const existed = existing.exitCode === 0;
  const added = await worktreeGit(existed ? ['worktree', 'add', '--', path, branch]
    : ['worktree', 'add', '-b', branch, '--', path], project, execution, true);
  if (!added.ok) return added;
  return { ok: true, path, branch, existed };
}

/** Resolve both ends before a destructive operation. Reject another project,
 * the main tree, and symlink escapes even if Git would accept the path. */
export async function validateManagedWorktree(projectRoot: string, path: string): Promise<string> {
  const project = await realpath(projectRoot);
  const managed = await realpath(resolve(project, WORKTREE_ROOT_REL));
  const actual = await realpath(path);
  if (!within(project, managed) || !within(managed, actual)) throw new Error('Worktree removal path escapes its managed project directory');
  return actual;
}

function within(root: string, path: string): boolean {
  const value = relative(root, path);
  return !!value && !isAbsolute(value) && value !== '..' && !value.startsWith('../') && !value.startsWith('..\\');
}
