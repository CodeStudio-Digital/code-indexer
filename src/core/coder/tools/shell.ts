import type { CoderTool, ToolContext, ToolResult } from '../core/tool.js';
import { ok, err } from '../core/tool.js';
import { RUN_COMMAND_DESC, maybeTerse } from './descriptions.js';
import { defaultLocalShellPort, type IShellPort } from '../ports/shell-port.js';
import { pathFor } from './paths.js';

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 100_000;

/**
 * Resolve the shell port for a tool invocation. Falls back to the
 * process-wide local adapter when no port is wired. The local adapter's
 * `exec()` preserves the exact behavior of the pre-refactor `runCommand()`:
 * same shell (bash on POSIX, cmd on Windows), same SIGKILL on timeout/abort,
 * same per-stream byte cap.
 */
function shellPort(ctx: ToolContext): IShellPort {
  return ctx.ports?.shell ?? defaultLocalShellPort();
}

/**
 * Plan-mode read-only allowlist for run_command. When the user has plan
 * mode active and hasn't yet approved a plan, we still want the agent to
 * be able to explore the workspace via shell — `grep`, `ls`, `cat`,
 * `git status`, etc. — without giving it the ability to mutate.
 *
 * The gate has two parts:
 *   1. A blocklist of shell metacharacters that allow composition
 *      (`;`, `&`, `|`, backticks, `$()`, redirections). Any of those
 *      and the command is rejected outright — they could chain into a
 *      mutating call no matter how innocent the head looks.
 *   2. An allowlist of well-known read-only command heads. `git` is
 *      special-cased to a smaller subcommand allowlist.
 *
 * This isn't a substitute for a real shell sandbox — it's a pragmatic
 * gate that catches the obvious cases and forces anything else through
 * `submit_plan`. The non-plan-mode path is unchanged.
 */
const READ_ONLY_HEADS = new Set([
  // POSIX text/file inspection
  'ls', 'cat', 'head', 'tail', 'wc', 'find', 'grep', 'rg', 'ack',
  'file', 'which', 'whereis', 'echo', 'pwd', 'stat', 'du', 'df',
  'env', 'whoami', 'uname', 'date', 'tree', 'sort', 'uniq', 'cut',
  'awk', 'sed', // sed is allowed only when not invoked with -i (checked below)
  // Windows equivalents
  'dir', 'type', 'where', 'findstr',
  // Node-y read tools that might appear in CI
  'node', // intentionally NOT here — node can do anything
]);
// Remove the `node` accidental entry to keep the comment honest.
READ_ONLY_HEADS.delete('node');

const READ_ONLY_GIT_SUBS = new Set([
  'status', 'diff', 'log', 'show', 'blame', 'ls-files', 'ls-tree',
  'rev-parse', 'rev-list', 'reflog', 'branch', 'tag', 'remote',
  'config', 'describe', 'shortlog', 'cat-file', 'fsck',
]);

const FORBIDDEN_METACHARS = /[;&|`$()<>]/;

function isReadOnlyCommand(cmd: string): { ok: true } | { ok: false; reason: string } {
  const trimmed = cmd.trim();
  if (!trimmed) return { ok: false, reason: 'empty command' };

  if (FORBIDDEN_METACHARS.test(trimmed)) {
    return {
      ok: false,
      reason: 'shell composition not allowed in plan mode (>, <, |, &, ;, $(), backticks)',
    };
  }

  const parts = trimmed.split(/\s+/);
  const head = parts[0];

  // sed is read-only EXCEPT for -i (in-place edit). Cover -i, -i.bak, -iN.
  if (head === 'sed' && parts.some((p) => p === '-i' || p.startsWith('-i.') || /^-i[A-Za-z0-9]/.test(p))) {
    return { ok: false, reason: 'sed -i mutates files' };
  }

  if (head === 'git') {
    const sub = parts[1];
    if (!sub || !READ_ONLY_GIT_SUBS.has(sub)) {
      return { ok: false, reason: `git ${sub ?? ''}: not in the read-only subcommand allowlist` };
    }
    // git branch can mutate via -d/-D/-m/-M/-c/-C; reject those flags.
    if (sub === 'branch' && parts.some((p) => /^-(d|D|m|M|c|C)$/.test(p))) {
      return { ok: false, reason: 'git branch with -d/-D/-m/-M/-c/-C mutates' };
    }
    // git tag mutates with -d or -f; reject.
    if (sub === 'tag' && parts.some((p) => p === '-d' || p === '-f' || p === '--delete' || p === '--force')) {
      return { ok: false, reason: 'git tag with -d/-f mutates' };
    }
    // git config mutates without --get/--list/--get-all and with values.
    // Conservatively allow only `git config --get/--list/--get-all/--get-regexp`.
    if (sub === 'config') {
      const ok = parts.some((p) => p === '--get' || p === '--list' || p === '-l' || p === '--get-all' || p === '--get-regexp');
      if (!ok) return { ok: false, reason: 'git config without --get/--list mutates' };
    }
    return { ok: true };
  }

  if (READ_ONLY_HEADS.has(head)) return { ok: true };
  return { ok: false, reason: `'${head}' is not in the read-only command allowlist` };
}

// The concrete streaming/timeout/abort loop lives in LocalShellAdapter.exec().
// The tool layer only owns policy (plan-mode gate, cwd validation, output
// formatting). See ../ports/shell-port.ts for implementation invariants.

function truncate(s: string, max = MAX_OUTPUT_BYTES): string {
  return s.length > max ? s.slice(0, max) + `\n... [truncated, ${s.length - max} bytes omitted]` : s;
}

const runCommandTool: CoderTool = {
  name: 'run_command',
  description: maybeTerse(RUN_COMMAND_DESC),
  source: 'native',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'Shell command to execute' },
      cwd: { type: 'string', description: 'Optional subdirectory relative to project root' },
      timeout_ms: { type: 'number', description: 'Timeout in ms (default 120000)' },
    },
    required: ['command'],
    additionalProperties: false,
  },
  handler: async (args, ctx): Promise<ToolResult> => {
    const command = String(args.command ?? '');
    if (!command.trim()) return err('command cannot be empty');

    // Plan mode: gate run_command to the read-only allowlist until the user
    // approves a plan. The runner removed run_command from MUTATING_TOOLS
    // precisely so this granular gate could decide per-command.
    if (ctx.runner?.isPlanMode() && !ctx.runner.isPlanApproved()) {
      const check = isReadOnlyCommand(command);
      if (!check.ok) {
        return err(
          `Command blocked in plan mode: ${check.reason}. ` +
            `Allowed: grep, rg, ls, cat, find, head, tail, wc, git status/diff/log/show, etc. ` +
            `Call submit_plan and wait for approval to run mutating commands.`
        );
      }
    }

    let cwd = ctx.cwd;
    if (args.cwd) {
      const sub = String(args.cwd);
      const p = pathFor(ctx.cwd);
      const abs = p.isAbsolute(sub) ? sub : p.resolve(ctx.cwd, sub);
      const rel = p.relative(ctx.cwd, abs);
      if (rel.startsWith('..') || p.isAbsolute(rel)) {
        return err(`cwd '${sub}' is outside project root`);
      }
      cwd = abs;
    }

    const timeout = typeof args.timeout_ms === 'number' ? args.timeout_ms : DEFAULT_TIMEOUT_MS;
    const result = await shellPort(ctx).exec(command, {
      cwd,
      timeoutMs: timeout,
      signal: ctx.signal,
      maxOutputBytes: MAX_OUTPUT_BYTES,
    });

    const lines: string[] = [];
    lines.push(`$ ${command}`);
    lines.push(`exit code: ${result.exitCode ?? 'killed'}${result.timedOut ? ' (timed out)' : ''}`);
    if (result.stdout.trim()) {
      lines.push('--- stdout ---');
      lines.push(truncate(result.stdout.trimEnd()));
    }
    if (result.stderr.trim()) {
      lines.push('--- stderr ---');
      lines.push(truncate(result.stderr.trimEnd()));
    }
    const out = lines.join('\n');
    return result.exitCode === 0 ? ok(out) : err(out);
  },
};

export const shellTools: CoderTool[] = [runCommandTool];
