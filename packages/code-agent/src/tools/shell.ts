import type { CoderTool, ToolContext, ToolResult } from '@mcp/code-agent/core/tool.js';
import { ok, err, unknownToolOutcome } from '@mcp/code-agent/core/tool.js';
import { RUN_COMMAND_DESC, maybeTerse } from '@mcp/code-agent/tools/descriptions.js';
import {
  boundUtf8OutputDetailed,
  defaultLocalShellPort,
  type IShellPort,
} from '@mcp/code-agent/ports/shell-port.js';
import { resolveWorkspacePath } from '@mcp/code-agent/tools/paths.js';
import { shellLabel } from '@mcp/code-agent/core/shell-info.js';
import { unsafeProcessCommandRefusal } from '@mcp/code-agent/tools/shell-command-safety.js';

const DEFAULT_TIMEOUT_MS = 120_000;
// Ceiling for a one-shot command. One-shot shell work (builds, installs,
// test suites) should finish well under this; for anything longer use a
// persistent `exec_command` session or a background terminal. Unity Editor
// batch jobs are the deliberate exception below: importing/compiling a project
// and then running tests can legitimately exceed this ceiling.
const MAX_TIMEOUT_MS = 10 * 60_000;
const UNITY_BATCH_TIMEOUT_MS = 30 * 60_000;
// Let the shell adapter own the user-facing timeout and cleanup first. The
// runner backstop fires only if the handler fails to settle after that cleanup.
const RUNNER_TIMEOUT_GRACE_MS = 5_000;
const MAX_OUTPUT_BYTES = 100_000;
const MAX_STDIN_BYTES = 100_000;

function isUnityBatchCommand(command: unknown): boolean {
  if (typeof command !== 'string') return false;
  const launchesUnityEditor = /(?:^|[\\/"'\s])unity(?:\.exe)?(?=$|["'\s])/i.test(command);
  const hasBatchFlag = /(?:^|\s)-(?:batchmode|runtests|executemethod|projectpath)(?=$|\s)/i.test(command);
  return launchesUnityEditor && hasBatchFlag;
}

function resolveHandlerTimeoutMs(args: Record<string, unknown>): number {
  const requested = typeof args.timeout_ms === 'number' && args.timeout_ms > 0
    ? args.timeout_ms
    : DEFAULT_TIMEOUT_MS;
  // A caller-provided five-minute timeout is commonly generated for all shell
  // commands. Treating that generic hint as authoritative killed valid Unity
  // test/import jobs. The 30-minute value is only a ceiling: a finished Unity
  // process still returns immediately.
  if (isUnityBatchCommand(args.command)) return UNITY_BATCH_TIMEOUT_MS;
  return Math.min(MAX_TIMEOUT_MS, requested);
}

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

const runCommandTool: CoderTool = {
  name: 'run_command',
  effectBoundary: 'shell',
  description: maybeTerse(RUN_COMMAND_DESC),
  source: 'native',
  outputPolicy: { mode: 'logs', reducer: 'smart', recovery: 'output_store', preserveOnError: true },
  // `mutates: false` is INTENTIONAL even though run_command can mutate
  // the workspace. The shell tool gates internally via `isReadOnlyCommand`
  // below — letting through `grep`, `ls`, `cat`, etc. during plan mode.
  // If we set `mutates: true` here the policy module would block ALL
  // commands during plan mode, including the read-only set the agent
  // needs to explore before submitting a plan. The internal allowlist
  // is the actual safety net here; `parallelSafe: false` because shell
  // side effects make concurrent dispatch unsafe regardless.
  mutates: false,
  parallelSafe: false,
  riskLevel: 'execute',
  // Command results are snapshots of mutable workspace/process state. They
  // must never be reused solely because command/cwd match a prior invocation.
  repeatPolicy: 'volatile',
  // Runner backstop includes a small cleanup grace after the handler's own
  // timeout. `resolveTimeoutMs` also makes a requested 120s timeout cover lane
  // acquisition instead of silently inheriting the static 10-minute ceiling.
  timeoutMs: MAX_TIMEOUT_MS + RUNNER_TIMEOUT_GRACE_MS,
  resolveTimeoutMs: (args) => resolveHandlerTimeoutMs(args) + RUNNER_TIMEOUT_GRACE_MS,
  parameters: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description:
          `Shell command — runs via ${shellLabel()}. See the system prompt's ` +
          `OS line for shell-specific dos/don'ts (e.g. on Windows it's cmd.exe: ` +
          `no \`| head\`/\`grep\`, use \`findstr\`/\`type\`).`,
      },
      cwd: {
        type: 'string',
        description: 'Optional subdirectory relative to the primary project. In a global session use "<project-slug>/subdir".',
      },
      timeout_ms: {
        type: 'number',
        description: 'Timeout in ms (default 120000, max 600000 / 10 min). Unity Editor batch/test commands automatically receive a 30-minute ceiling.',
      },
      stdin: {
        type: 'string',
        description:
          'Optional payload written to the process stdin (then EOF). Use this to feed ' +
          'multi-line code to interpreters: command="python -" with the script body in ' +
          'stdin, or command="node -" / command="bash". Avoids cross-shell quoting bugs ' +
          '(here-strings, backslashes, $VAR expansion differ between cmd / bash / ' +
          'PowerShell / sh-in-container). Max 100000 bytes.',
      },
    },
    required: ['command'],
    additionalProperties: false,
  },
  handler: async (args, ctx): Promise<ToolResult> => {
    const command = String(args.command ?? '');
    if (!command.trim()) return err('command cannot be empty');

    const unsafeProcessCommand = unsafeProcessCommandRefusal(command);
    if (unsafeProcessCommand) return err(unsafeProcessCommand);

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
      const resolved = resolveWorkspacePath(sub, ctx, 'read');
      if (!resolved.ok) {
        return err(
          resolved.reason.includes('outside project root')
            ? `cwd '${sub}' is outside project root`
            : `cwd '${sub}' rejected: ${resolved.reason}`,
        );
      }
      if (resolved.external) {
        return err(
          `cwd '${sub}' is an authorized external root, but local shell execution stays project-scoped ` +
            'because it cannot yet be confined to one host directory. Use glob/read_file/list_directory ' +
            'and other native filesystem tools for external roots.',
        );
      }
      cwd = resolved.abs;
    }

    let stdin: string | undefined;
    if (args.stdin !== undefined && args.stdin !== null) {
      if (typeof args.stdin !== 'string') return err('stdin must be a string');
      if (Buffer.byteLength(args.stdin, 'utf-8') > MAX_STDIN_BYTES) {
        return err(`stdin exceeds ${MAX_STDIN_BYTES} bytes; stage to a file and read it instead`);
      }
      stdin = args.stdin;
    }

    const timeout = resolveHandlerTimeoutMs(args);
    const result = await shellPort(ctx).exec(command, {
      cwd,
      timeoutMs: timeout,
      signal: ctx.signal,
      maxOutputBytes: MAX_OUTPUT_BYTES,
      stdin,
      // Put the project's PHP/Python (not Node) on PATH for this command.
      runtimeEnv: ctx.runtimeEnv,
    });

    const headerLines = [
      `$ ${command}`,
      `exit code: ${result.exitCode ?? (result.terminationUnconfirmed ? 'unconfirmed' : 'killed')}${result.timedOut ? ' (timed out)' : ''}`,
    ];
    if (result.processId) headerLines.push(`command PID: ${result.processId}`);
    if (result.outputDrainTimedOut) headerLines.push(
      'The command exited; a descendant kept output handles open. Capture was closed after draining. Background processes may still be running; inspect the returned PID/logs before launching again.',
    );
    if (result.timedOut) headerLines.push(
      'The command reached its requested deadline. Inspect partial output and current state before retrying. For servers, watchers, or work that must continue, use exec_command and poll its session with write_stdin.',
    );
    if (result.terminationUnconfirmed) headerLines.push(
      `Termination could not be confirmed${result.processId ? ` (command PID ${result.processId})` : ''}. Inspect process state and outputs; do not launch a duplicate.`,
    );
    const stdoutBounded = boundUtf8OutputDetailed(result.stdout, MAX_OUTPUT_BYTES);
    const stderrBounded = boundUtf8OutputDetailed(result.stderr, MAX_OUTPUT_BYTES);
    const localMaterializedGuardApplied = !!stdoutBounded.truncation || !!stderrBounded.truncation;
    const upstreamStreamAlreadyLost = !!result.stdoutTruncation || !!result.stderrTruncation;

    // A custom/remote adapter may hand us an oversized but still complete
    // materialized result. Persist the complete tool result before the local
    // defensive guard cuts it. The LocalShellAdapter is intentionally
    // different: it discards the middle incrementally, so its truncation
    // metadata can never honestly advertise lossless recovery here.
    let completeOutputId: string | undefined;
    if (localMaterializedGuardApplied && !upstreamStreamAlreadyLost && ctx.toolOutputStore) {
      const completeLines = [...headerLines];
      if (result.stdout.length > 0) completeLines.push('--- stdout ---', result.stdout);
      if (result.stderr.length > 0) completeLines.push('--- stderr ---', result.stderr);
      completeOutputId = ctx.toolOutputStore.put(completeLines.join('\n')) ?? undefined;
    }
    const materializedGuardRecoverable = !!completeOutputId;

    const lines: string[] = [...headerLines];
    const sourceTruncations: NonNullable<ToolResult['sourceTruncations']> = [];
    if (result.stdout.length > 0) {
      lines.push('--- stdout ---');
      // LocalShellAdapter has already bounded streaming output. Apply the
      // same head+true-tail fallback for remote/custom adapters that return
      // an oversized materialized string despite maxOutputBytes.
      lines.push(stdoutBounded.content);
      if (result.stdoutTruncation) {
        sourceTruncations.push({
          technique: 'bounded-stream-cap:stdout',
          inputSize: result.stdoutTruncation.inputBytes,
          outputSize: result.stdoutTruncation.outputBytes,
          unit: 'bytes',
          recoverable: false,
        });
      }
      if (stdoutBounded.truncation) {
        sourceTruncations.push({
          technique: result.stdoutTruncation
            ? 'bounded-stream-cap:stdout:local-guard'
            : 'bounded-stream-cap:stdout',
          inputSize: stdoutBounded.truncation.inputBytes,
          outputSize: stdoutBounded.truncation.outputBytes,
          unit: 'bytes',
          recoverable: materializedGuardRecoverable,
          ...(completeOutputId ? { outputId: completeOutputId } : {}),
        });
      }
    }
    if (result.stderr.length > 0) {
      lines.push('--- stderr ---');
      lines.push(stderrBounded.content);
      if (result.stderrTruncation) {
        sourceTruncations.push({
          technique: 'bounded-stream-cap:stderr',
          inputSize: result.stderrTruncation.inputBytes,
          outputSize: result.stderrTruncation.outputBytes,
          unit: 'bytes',
          recoverable: false,
        });
      }
      if (stderrBounded.truncation) {
        sourceTruncations.push({
          technique: result.stderrTruncation
            ? 'bounded-stream-cap:stderr:local-guard'
            : 'bounded-stream-cap:stderr',
          inputSize: stderrBounded.truncation.inputBytes,
          outputSize: stderrBounded.truncation.outputBytes,
          unit: 'bytes',
          recoverable: materializedGuardRecoverable,
          ...(completeOutputId ? { outputId: completeOutputId } : {}),
        });
      }
    }
    const out = lines.join('\n');
    return {
      ...(result.terminationUnconfirmed ? unknownToolOutcome(out) : {}),
      content: out,
      ...(result.exitCode === 0 ? {} : { isError: true }),
      ...(sourceTruncations.length > 0 ? { sourceTruncations } : {}),
    };
  },
};

export const shellTools: CoderTool[] = [runCommandTool];
