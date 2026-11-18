import { resolve } from 'node:path';
import { readWorktreeGit } from '@mcp/api-handlers/projectGit/index.js';
import {
  listProjectWorktrees as list, resolveProjectWorktree as resolveCheckout,
  resolveSessionWorkspaceRoot as resolveSession, type WorktreeReadOptions,
} from '@mcp/code-agent/tools/project-worktrees.js';

type ReadGit = NonNullable<WorktreeReadOptions['readGit']>;
type Result = Awaited<ReturnType<ReadGit>>;
interface Pending { result: Promise<Result>; controller: AbortController; readers: number }
const pending = new Map<string, Pending>();

/** Only overlapping local reads share a process. A later membership check always reads Git again. */
const readGit: ReadGit = (args, cwd, { signal } = {}) => {
  signal?.throwIfAborted();
  const absolute = resolve(cwd);
  const key = JSON.stringify([process.platform === 'win32' ? absolute.toLowerCase() : absolute, args]);
  let entry = pending.get(key);
  if (!entry) {
    const controller = new AbortController();
    const result = readWorktreeGit(cwd, args, controller.signal).then((git): Result => (
      git.code === 0 && !git.truncated
        ? { ok: true, exitCode: 0, out: git.stdout.trim() }
        : { ok: false, error: git.stderr.trim() || 'Git could not read the worktree metadata' }
    )).finally(() => {
      if (pending.get(key)?.controller === controller) pending.delete(key);
    });
    entry = { result, controller, readers: 0 };
    pending.set(key, entry);
  }
  const shared = entry;
  shared.readers++;
  return new Promise<Result>((done, reject) => {
    const abort = () => {
      if (--shared.readers === 0) {
        if (pending.get(key) === shared) pending.delete(key);
        shared.controller.abort();
      }
      reject(signal!.reason);
    };
    signal?.addEventListener('abort', abort, { once: true });
    shared.result.then(done, reject).finally(() => signal?.removeEventListener('abort', abort));
  });
};

function localReads(options: WorktreeReadOptions = {}): WorktreeReadOptions {
  return options.shell || options.runtimeEnv || options.readGit ? options : { ...options, readGit };
}

export const listProjectWorktrees: typeof list = (root, options) => list(root, localReads(options));
export const resolveProjectWorktree: typeof resolveCheckout = (root, path, options) =>
  resolveCheckout(root, path, localReads(options));
export const resolveSessionWorkspaceRoot: typeof resolveSession = (root, session, options) =>
  resolveSession(root, session, localReads(options));
