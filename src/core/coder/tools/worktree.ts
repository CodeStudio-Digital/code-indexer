import { spawnSync } from 'node:child_process';
import { mkdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { CoderTool, ToolContext, ToolResult } from '../core/tool.js';
import { ok, err } from '../core/tool.js';

/**
 * enter_worktree / exit_worktree — isolated git worktree session scope.
 *
 * Creates a sibling worktree under `.mcp-indexer/worktrees/<name>/` so the
 * agent can run risky experiments (refactors, dependency bumps, schema
 * migrations) without touching the user's working tree on the original
 * branch. On enter, the runner's cwd is swapped for the worktree path for
 * every subsequent tool call in the session. On exit, cwd is restored and
 * the worktree can be either kept (for later inspection) or removed.
 *
 * Admin tier only. These operations modify git state and create/delete
 * branches — never auto-promoted.
 */

export const WORKTREE_ROOT_REL = '.mcp-indexer/worktrees';
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

interface RunnerWithCwd {
  toolContext?: { cwd: string };
  // Back-references added below by the runner side of this file.
  originalCwd?: string;
  worktreePath?: string | null;
}

function runGit(args: string[], cwd: string): { ok: true; out: string } | { ok: false; error: string } {
  const r = spawnSync('git', args, { cwd, encoding: 'utf-8' });
  if (r.error) return { ok: false, error: `git spawn failed: ${r.error.message}` };
  const stdout = (r.stdout ?? '').trim();
  const stderr = (r.stderr ?? '').trim();
  if (r.status !== 0) {
    return { ok: false, error: `git ${args.join(' ')} exited ${r.status}: ${stderr || stdout}` };
  }
  return { ok: true, out: stdout };
}

function ensureGitRepo(cwd: string): string | null {
  if (!existsSync(join(cwd, '.git'))) {
    const r = runGit(['rev-parse', '--is-inside-work-tree'], cwd);
    if (!r.ok) return 'not inside a git repository (worktree requires git)';
    if (r.out !== 'true') return 'not inside a git working tree';
  }
  return null;
}

/**
 * Create a git worktree under `<projectRoot>/.mcp-indexer/worktrees/<name>/`
 * and return its absolute path + the branch checked out. Extracted from the
 * `enter_worktree` tool handler so both runCoder() (session-start) and the
 * tool (mid-session) can share the same validation and git plumbing.
 *
 * Returns a tagged union so callers can distinguish "git missing" from
 * "name collision" without parsing error strings.
 */
export function createProjectWorktree(
  projectRoot: string,
  options: { name?: string; branch?: string } = {},
): { ok: true; path: string; branch: string; existed: boolean } | { ok: false; error: string } {
  const gitErr = ensureGitRepo(projectRoot);
  if (gitErr) return { ok: false, error: gitErr };

  const rawName = typeof options.name === 'string' ? options.name.trim() : '';
  const name =
    rawName || `wt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  if (!NAME_RE.test(name)) {
    return {
      ok: false,
      error: `invalid worktree name '${name}'. Allowed: letters, digits, '.', '_', '-'. 1-64 chars.`,
    };
  }

  const worktreesDir = resolve(projectRoot, WORKTREE_ROOT_REL);
  mkdirSync(worktreesDir, { recursive: true });
  const worktreePath = join(worktreesDir, name);
  if (existsSync(worktreePath)) {
    return {
      ok: false,
      error: `worktree path '${worktreePath}' already exists. Pick a different name.`,
    };
  }

  const branch =
    typeof options.branch === 'string' && options.branch.trim()
      ? options.branch.trim()
      : `coder/${name}`;

  const branchExists = runGit(['rev-parse', '--verify', branch], projectRoot).ok;
  const addArgs = branchExists
    ? ['worktree', 'add', worktreePath, branch]
    : ['worktree', 'add', '-b', branch, worktreePath];
  const addResult = runGit(addArgs, projectRoot);
  if (!addResult.ok) return { ok: false, error: addResult.error };

  return { ok: true, path: worktreePath, branch, existed: branchExists };
}

// ── enter_worktree ───────────────────────────────────────────────

export const enterWorktree: CoderTool = {
  name: 'enter_worktree',
  description:
    'Create an isolated git worktree under .mcp-indexer/worktrees/<name> and switch this session into it. Subsequent tool calls run against the worktree instead of the original working directory.\n' +
    "USE: risky experiments — schema migrations, dependency upgrades, large refactors — where you want to try something and keep the main branch pristine.\n" +
    "USE: parallel branches when you want to build on a feature branch without leaving the user's current branch.\n" +
    "DON'T: enter a worktree for a trivial edit — it's heavy and requires explicit exit_worktree later.\n" +
    "DON'T: enter nested worktrees — exit the current one first.\n" +
    'Admin tier. Requires expand_toolset("admin") first. The session remembers the worktree across restarts via the `worktree_path` column.',
  source: 'native',
  parameters: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'Short identifier for the worktree directory. Letters, digits, dot, underscore, dash. 1-64 chars. If omitted, a timestamp-based name is generated.',
      },
      branch: {
        type: 'string',
        description: 'Branch to check out in the worktree. Creates it from HEAD if it does not exist. Defaults to "coder/<name>".',
      },
    },
    additionalProperties: false,
  },
  handler: async (args, ctx: ToolContext): Promise<ToolResult> => {
    const runner = ctx.runner as unknown as
      | (RunnerWithCwd & { enterWorktreeScope?: (abs: string) => void })
      | undefined;
    if (!runner || typeof runner.enterWorktreeScope !== 'function') {
      return err('enter_worktree requires a runner that supports worktree scoping.');
    }
    if (runner.worktreePath) {
      return err(
        `Already inside a worktree at ${runner.worktreePath}. Call exit_worktree first if you want to switch.`,
      );
    }

    // The ORIGINAL project root, not the current cwd (which could be a
    // worktree we failed to exit). Use the runner's remembered original.
    const projectRoot = runner.originalCwd ?? ctx.cwd;
    const result = createProjectWorktree(projectRoot, {
      name: typeof args.name === 'string' ? args.name : undefined,
      branch: typeof args.branch === 'string' ? args.branch : undefined,
    });
    if (!result.ok) return err(result.error);

    runner.enterWorktreeScope(result.path);
    return ok(
      `Entered worktree: ${result.path}\nbranch: ${result.branch} (${result.existed ? 'existing' : 'new from HEAD'})\n` +
        'Subsequent file, shell, and git tool calls run against this worktree. Call exit_worktree when done.',
    );
  },
};

// ── exit_worktree ────────────────────────────────────────────────

export const exitWorktree: CoderTool = {
  name: 'exit_worktree',
  description:
    'Leave the current worktree and restore the session cwd to the original project root.\n' +
    "USE: action:'keep' to preserve the worktree on disk (e.g. you want to come back to it, or it has uncommitted work you want to review).\n" +
    "USE: action:'remove' when the experiment is done and you want the worktree gone. discard_changes must be true if the worktree has uncommitted files or unmerged commits — this prevents accidental work loss.\n" +
    "DON'T: call exit_worktree({action:'remove'}) without first checking git status inside the worktree.\n" +
    'Admin tier. No-op when not currently in a worktree.',
  source: 'native',
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['keep', 'remove'],
        description: 'keep: restore cwd, leave files on disk. remove: restore cwd and git-worktree-remove the directory.',
      },
      discard_changes: {
        type: 'boolean',
        description: 'Required true when action=remove and the worktree has uncommitted or unmerged work. Refuses to remove otherwise.',
      },
    },
    required: ['action'],
    additionalProperties: false,
  },
  handler: async (args, ctx: ToolContext): Promise<ToolResult> => {
    const runner = ctx.runner as unknown as
      | (RunnerWithCwd & { exitWorktreeScope?: () => void })
      | undefined;
    if (!runner || typeof runner.exitWorktreeScope !== 'function') {
      return err('exit_worktree requires a runner that supports worktree scoping.');
    }
    const wtPath = runner.worktreePath;
    if (!wtPath) {
      return ok('No worktree currently active — nothing to exit.');
    }
    const action = String(args.action ?? '').trim();
    if (action !== 'keep' && action !== 'remove') {
      return err('action must be "keep" or "remove"');
    }
    const projectRoot = runner.originalCwd ?? ctx.cwd;

    if (action === 'keep') {
      runner.exitWorktreeScope();
      return ok(
        `Left worktree: ${wtPath} (kept on disk).\nSession cwd restored to ${projectRoot}.`,
      );
    }

    // action === 'remove' — check for uncommitted changes unless the caller
    // explicitly said to discard.
    const statusRes = runGit(['status', '--porcelain'], wtPath);
    const hasChanges = statusRes.ok && statusRes.out.length > 0;
    const discard = Boolean(args.discard_changes);

    if (hasChanges && !discard) {
      return err(
        `worktree at ${wtPath} has uncommitted changes:\n${statusRes.ok ? statusRes.out : '(status failed)'}\n` +
          'Pass discard_changes:true to remove anyway, or action:"keep" to preserve them.',
      );
    }

    // Restore cwd BEFORE removing the directory — otherwise tools that run
    // between the runner state flip and the fs delete would see a missing path.
    runner.exitWorktreeScope();

    const removeArgs = discard
      ? ['worktree', 'remove', '--force', wtPath]
      : ['worktree', 'remove', wtPath];
    const rm = runGit(removeArgs, projectRoot);
    if (!rm.ok) {
      return err(
        `cwd restored to ${projectRoot} but git worktree remove failed: ${rm.error}. Clean up manually with 'git worktree remove --force ${wtPath}'.`,
      );
    }
    return ok(
      `Exited and removed worktree: ${wtPath}.\nSession cwd restored to ${projectRoot}.${discard ? ' (uncommitted changes discarded)' : ''}`,
    );
  },
};

export const worktreeTools: CoderTool[] = [enterWorktree, exitWorktree];
