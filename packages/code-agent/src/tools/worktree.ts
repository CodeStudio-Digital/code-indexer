import type { CoderTool, ToolContext, ToolResult } from '@mcp/code-agent/core/tool.js';
import { ok, err, unknownToolOutcome } from '@mcp/code-agent/core/tool.js';
import { createProjectWorktree, validateManagedWorktree, worktreeGit } from './worktree-operations.js';
export { createProjectWorktree, WORKTREE_ROOT_REL } from './worktree-operations.js';

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

interface RunnerWithCwd {
  toolContext?: { cwd: string };
  // Back-references added below by the runner side of this file.
  originalCwd?: string;
  worktreePath?: string | null;
}

// ── enter_worktree ───────────────────────────────────────────────

export const enterWorktree: CoderTool = {
  name: 'enter_worktree',
  mutates: true,
  parallelSafe: false,
  riskLevel: 'admin',
  effectBoundary: 'shell',
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
    if ((args.name !== undefined && typeof args.name !== 'string')
      || (args.branch !== undefined && typeof args.branch !== 'string')) return err('Worktree name and branch must be strings.');
    const result = await createProjectWorktree(projectRoot, {
      name: typeof args.name === 'string' ? args.name : undefined,
      branch: typeof args.branch === 'string' ? args.branch : undefined,
    }, { shell: ctx.ports?.shell, signal: ctx.signal, runtimeEnv: ctx.runtimeEnv });
    if (!result.ok) return result.outcomeUnknown ? unknownToolOutcome(result.error) : err(result.error);

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
  mutates: true,
  parallelSafe: false,
  riskLevel: 'admin',
  effectBoundary: 'shell',
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
    if (ctx.worktreeWorkspace) {
      return err('This session belongs to a worktree workspace. Select Main or another worktree in the workspace bar and use a session there; this checkout may be shared by other sessions.');
    }
    if (!wtPath) {
      return ok('No worktree currently active — nothing to exit.');
    }
    const action = String(args.action ?? '').trim();
    if (action !== 'keep' && action !== 'remove') {
      return err('action must be "keep" or "remove"');
    }
    const projectRoot = runner.originalCwd ?? ctx.cwd;
    ctx.signal?.throwIfAborted();
    if (args.discard_changes !== undefined && typeof args.discard_changes !== 'boolean') {
      return err('discard_changes must be a boolean.');
    }

    if (action === 'keep') {
      runner.exitWorktreeScope();
      return ok(
        `Left worktree: ${wtPath} (kept on disk).\nSession cwd restored to ${projectRoot}.`,
      );
    }

    // action === 'remove' — check for uncommitted changes unless the caller
    // explicitly said to discard.
    let actual: string;
    try { actual = await validateManagedWorktree(projectRoot, wtPath); }
    catch (cause) { return err(String(cause)); }
    const execution = { shell: ctx.ports?.shell, signal: ctx.signal, runtimeEnv: ctx.runtimeEnv };
    const statusRes = await worktreeGit(['status', '--porcelain'], actual, execution);
    if (!statusRes.ok) return err(`Worktree status could not be verified; removal was not attempted. ${statusRes.error}`);
    const hasChanges = statusRes.out.length > 0;
    const discard = args.discard_changes === true;

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
      ? ['worktree', 'remove', '--force', '--', actual]
      : ['worktree', 'remove', '--', actual];
    const rm = await worktreeGit(removeArgs, projectRoot, execution, true);
    if (!rm.ok) {
      if (rm.outcomeUnknown) return unknownToolOutcome(rm.error);
      return err(
        `cwd restored to ${projectRoot} but git worktree remove failed: ${rm.error}. Inspect the worktree and its files before another removal attempt.`,
      );
    }
    return ok(
      `Exited and removed worktree: ${wtPath}.\nSession cwd restored to ${projectRoot}.${discard ? ' (uncommitted changes discarded)' : ''}`,
    );
  },
};

export const worktreeTools: CoderTool[] = [enterWorktree, exitWorktree];
