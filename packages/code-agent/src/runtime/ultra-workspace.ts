import { createHash, randomUUID } from 'node:crypto';
import { copyFile, lstat, mkdir, readFile, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { defaultLocalShellPort } from '../ports/shell-port.js';
import type { ToolContext, CoderTool } from '../core/tool.js';
import { childChatId } from '@mcp/session-storage/collaboration/types.js';
import { defaultLocalFilesystemPort, type IFilesystemPort } from '../ports/filesystem-port.js';
import { lockUltraIntegration } from './ultra-integration-lock.js';

export interface UltraWorkspace {
  actor: string; source: string; path: string; baseTree: string;
  hashes: Record<string, string>; hashAlgorithm: string;
  files: string[]; diff: string; integrated: boolean;
}
const localShell = defaultLocalShellPort();
async function git(cwd: string, args: string[], signal?: AbortSignal, stdin?: string): Promise<string> {
  const result = await localShell.spawn('git', args, { cwd, signal, stdin, timeoutMs: 300_000, maxOutputBytes: 32 * 1024 * 1024 });
  if (result.exitCode !== 0 || result.timedOut || result.stdoutTruncation || result.stderrTruncation) {
    throw new Error(`Isolated checkout: git ${args[0]} failed: ${result.stderr.slice(0, 1200)}`);
  }
  return result.stdout;
}
export function inside(root: string, path: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`));
}
export async function safeWorkspacePath(root: string, file: string): Promise<string> {
  const target = resolve(root, file);
  if (!inside(root, target) || file.split(/[\\/]/).includes('.git')) throw new Error('File escapes the isolated task workspace');
  let ancestor = target;
  for (;;) {
    try {
      const actual = await realpath(ancestor);
      if (!inside(await realpath(root), actual) || (await lstat(ancestor)).isSymbolicLink()) throw new Error('Workspace path crosses a symbolic link');
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = dirname(ancestor); if (parent === ancestor) throw error; ancestor = parent;
    }
  }
  return target;
}

export async function prepareUltraWorkspace(ctx: ToolContext, spawnId: string): Promise<UltraWorkspace> {
  if (!ctx.collaboration || !ctx.sessionId) throw new Error('An isolated implementation needs a durable chat');
  const source = await realpath(ctx.cwd);
  await git(source, ['rev-parse', '--verify', 'HEAD'], ctx.signal);
  const managed = join(source, '.mcp-indexer', 'worktrees');
  await safeWorkspacePath(source, '.mcp-indexer/worktrees');
  await mkdir(managed, { recursive: true });
  const path = join(managed, `ultra-${randomUUID()}`);
  const patch = await git(source, ['diff', '--binary', 'HEAD', '--'], ctx.signal);
  const untracked = (await git(source, ['ls-files', '--others', '--exclude-standard', '-z'], ctx.signal)).split('\0').filter(Boolean);
  await git(source, ['worktree', 'add', '--detach', '--', path, 'HEAD'], ctx.signal);
  try {
    if (patch.trim()) await git(path, ['apply', '--binary', '-'], ctx.signal, patch);
    for (const file of untracked) {
      if (file.startsWith('.mcp-indexer/')) continue;
      const from = await safeWorkspacePath(source, file);
      if (!(await lstat(from)).isFile()) continue;
      const to = await safeWorkspacePath(path, file);
      await mkdir(dirname(to), { recursive: true }); await copyFile(from, to);
    }
    await git(path, ['add', '--all', '--', '.'], ctx.signal);
    const baseTree = (await git(path, ['write-tree'], ctx.signal)).trim();
    const hashes: Record<string, string> = {};
    for (const entry of (await git(path, ['ls-files', '--stage', '-z'], ctx.signal)).split('\0')) {
      const match = /^\d+ ([a-f0-9]+) 0\t([\s\S]+)$/.exec(entry);
      if (match) hashes[match[2]] = gitBlobHash(await readFile(await safeWorkspacePath(path, match[2])),
        match[1].length === 64 ? 'sha256' : 'sha1');
    }
    return { actor: childChatId(ctx.sessionId, spawnId), source, path, baseTree, hashes,
      hashAlgorithm: (await git(path, ['rev-parse', '--show-object-format'], ctx.signal)).trim(), files: [], diff: '', integrated: false };
  } catch (error) {
    // Failed preparation never produced agent changes; removal stays under the verified managed root.
    if (inside(managed, path)) await git(source, ['worktree', 'remove', '--force', '--', path]).catch(() => undefined);
    throw error;
  }
}

export async function captureUltraWorkspace(workspace: UltraWorkspace, signal?: AbortSignal): Promise<UltraWorkspace> {
  await git(workspace.path, ['add', '--all', '--', '.'], signal);
  const files = (await git(workspace.path, ['diff', '--cached', '--name-only', '--no-renames', '-z', workspace.baseTree], signal)).split('\0').filter(Boolean);
  const diff = await git(workspace.path, ['diff', '--cached', '--binary', '--no-renames', workspace.baseTree], signal);
  return { ...workspace, files, diff };
}

export function gitBlobHash(bytes: Buffer, algorithm = 'sha1'): string {
  return createHash(algorithm).update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

/** Native writes are scoped. Host shell/MCP execution stays with the coordinator. */
export function isolatedChildTool(tool: CoderTool): boolean {
  if (tool.executionClass === 'control' && tool.riskLevel === 'read') return true;
  if (tool.source !== 'native' || tool.name === 'code_exec') return false;
  if (['run_command', 'exec_command', 'enter_worktree', 'exit_worktree'].includes(tool.name)) return false;
  if (tool.mutates || (tool.riskLevel && tool.riskLevel !== 'read')) {
    return ['write_file', 'edit_file', 'multi_edit', 'create_file', 'manage_path', 'apply_patch'].includes(tool.name);
  }
  return true;
}

export function confinedWorkspaceFilesystem(root: string): IFilesystemPort {
  const local = defaultLocalFilesystemPort();
  let fence: (() => ToolContext['mutationFence']) | undefined;
  const mutations = new Set(['writeFile', 'createFile', 'createFileBytes', 'mkdir', 'unlink', 'rename', 'renameNoReplace', 'rm']);
  return new Proxy(local, {
    get(target, key) {
      if (key === 'setMutationFenceSource') return (source: typeof fence) => { fence = source; };
      const value = Reflect.get(target, key);
      if (typeof value !== 'function') return value;
      if (key === 'iterateDirectory') return async function* (path: string, signal?: AbortSignal) {
        await safeWorkspacePath(root, relative(root, path));
        yield* local.iterateDirectory!(path, signal);
      };
      return async (...args: unknown[]) => {
        if (typeof args[0] === 'string') await safeWorkspacePath(root, relative(root, args[0]));
        if (['rename', 'renameNoReplace'].includes(String(key)) && typeof args[1] === 'string') await safeWorkspacePath(root, relative(root, args[1]));
        if (mutations.has(String(key))) fence?.()?.assertMutation({ kind: 'filesystem', operation: String(key), resource: String(args[0]) });
        return Reflect.apply(value, target, args);
      };
    },
  });
}

/** Serialize integration per checkout, including disjoint batches in one worker. */
const integrations = new Map<string, Promise<void>>();
export async function integrateUltraWorkspace(ctx: ToolContext, workspace: UltraWorkspace): Promise<void> {
  if (!ctx.ports?.fs || resolve(ctx.cwd) !== resolve(workspace.source)) throw new Error('Original workspace is unavailable');
  const key = resolve(workspace.source).toLowerCase();
  const previous = integrations.get(key) ?? Promise.resolve();
  let release!: () => void;
  const barrier = new Promise<void>(done => { release = done; });
  integrations.set(key, previous.catch(() => undefined).then(() => barrier));
  await previous.catch(() => undefined);
  const backups = new Map<string, string | null>();
  const next = new Map<string, string | null>();
  let unlock: (() => Promise<void>) | undefined;
  try {
    unlock = await lockUltraIntegration(workspace.source);
    for (const file of workspace.files) {
      ctx.signal?.throwIfAborted();
      const target = await safeWorkspacePath(workspace.source, file);
      const bytes = await readFile(target).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      const incoming = await readFile(await safeWorkspacePath(workspace.path, file)).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      // Reconcile a confirmed earlier write after a crash between file effects and checkpoint publication.
      if (bytes === null ? incoming === null : incoming !== null && bytes.equals(incoming)) continue;
      if ((bytes ? gitBlobHash(bytes, workspace.hashAlgorithm) : undefined) !== workspace.hashes[file]) throw new Error(`Integration conflict: ${file} changed after delegation. Review and reconcile it first.`);
      for (const content of [bytes, incoming]) if (content && !Buffer.from(content.toString('utf8'), 'utf8').equals(content)) throw new Error(`Binary file needs explicit integration: ${file}`);
      backups.set(target, bytes?.toString('utf8') ?? null); next.set(target, incoming?.toString('utf8') ?? null);
    }
    const applied: string[] = [];
    try {
      for (const [target, content] of next) {
        ctx.signal?.throwIfAborted();
        const current = await ctx.ports.fs.readFile(target).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
        if (current !== backups.get(target)) throw new Error('Integration conflict: file changed during integration: ' + target);
        ctx.mutationFence?.assertMutation({ kind: 'filesystem', operation: 'integrate_chat_changes', resource: target });
        applied.push(target);
        if (content === null) await ctx.ports.fs.unlink(target);
        else { await ctx.ports.fs.mkdir(dirname(target), { recursive: true }); await ctx.ports.fs.writeFile(target, content); }
      }
    } catch (error) {
      const failures: unknown[] = [];
      for (const target of applied.reverse()) {
        try {
          const old = backups.get(target)!;
          if (old === null) await ctx.ports.fs.unlink(target);
          else await ctx.ports.fs.writeFile(target, old);
        } catch (rollbackError) { failures.push(rollbackError); }
      }
      if (failures.length) throw new Error('Integration outcome unknown: rollback was incomplete. Inspect files before retrying.', { cause: error });
      throw error;
    }
  } finally { try { await unlock?.(); } finally { release(); } }
}

export async function archiveIntegratedWorkspace(workspace: UltraWorkspace): Promise<void> {
  const root = join(workspace.source, '.mcp-indexer', 'worktrees');
  const actual = await realpath(workspace.path);
  if (!inside(root, actual) || actual === root) throw new Error('Refusing cleanup outside managed checkouts');
  // The reviewed diff remains in the durable collaboration checkpoint.
  await git(workspace.source, ['worktree', 'remove', '--force', '--', actual]);
}
