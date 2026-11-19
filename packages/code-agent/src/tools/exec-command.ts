/**
 * exec_command / write_stdin — persistent shell sessions.
 *
 * Port of OpenAI Codex's `unified_exec` (codex-rs/core/src/tools/handlers/
 * unified_exec/). Pairs two tools that share a process registry:
 *
 *   exec_command: spawn a shell command, yield after `yield_time_ms`,
 *                 return whatever has been emitted so far + the
 *                 session_id. If the process is still alive, the model
 *                 can call `write_stdin` to interact with it.
 *
 *   write_stdin:  push bytes into an existing session's stdin (or empty
 *                 string for a background poll), yield briefly, return
 *                 incremental output.
 *
 * exec_command vs the one-shot `run_command`: run_command runs a command to
 * completion (or timeout) and returns the full output — it can't keep a REPL
 * alive across model turns. exec_command holds the process open so the model
 * can carry on a multi-turn conversation with it (node REPL, python -i, psql,
 * npm init, etc.). Pass `tty: true` for a real pseudo-terminal when a command
 * gates on isatty() — this replaced the old one-shot `run_command_pty` tool.
 *
 * Two transports:
 *   - pipe (default): plain `child_process.spawn` with piped stdio.
 *     Works without native deps; sufficient for non-tty REPLs.
 *   - pty (opt-in): `node-pty`-backed for commands that need a real TTY
 *     (ncurses, prompts that gate on isatty()). Same dynamic-import dance
 *     as pty.ts — absent module returns an actionable error.
 */
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { CoderTool, ToolContext, ToolResult } from '@mcp/code-agent/core/tool.js';
import { ok, err } from '@mcp/code-agent/core/tool.js';
import { applyRuntimeEnv, cleanProcessEnv, type AgentRuntimeEnv } from '@mcp/code-agent/ports/shell-port.js';
import { killProcessTree, trackProcessTree } from '@mcp/shared/utils/process-tree.js';
import { electronWindowsPtyOptions } from '@mcp/shared/utils/windows-pty.js';
import { unsafeProcessCommandRefusal } from '@mcp/code-agent/tools/shell-command-safety.js';
import { assertMutationFence } from '@mcp/code-agent/core/mutation-fence.js';
import { resolveWorkspacePath } from '@mcp/code-agent/tools/paths.js';
import { commandSpec, commandLaunch, commandDisplay, type CommandSpec } from './command-spec.js';
import { ProcessOutput, readProcessOutput } from './process-output.js';
import { registerBackgroundNoticeSource } from '@mcp/code-agent/core/background-notices.js';

// ─── Tunables ──────────────────────────────────────────────────────

// Long enough for typical focused tests/lint/builds to finish inside the
// first call; exit still releases the wait immediately.
const DEFAULT_EXEC_YIELD_MS = 30_000;
const DEFAULT_WRITE_YIELD_MS = 250;
const DEFAULT_POLL_YIELD_MS = 10_000;
/**
 * An empty poll of a command that never received stdin is a wait for
 * completion: it returns as soon as the process exits, so a long floor costs
 * nothing for fast processes and removes repeated poll-only model rounds for
 * slow ones (each round re-sends the whole transcript). Interactive sessions
 * keep the short platform waits.
 */
const COMPLETION_POLL_FLOOR_MS = 30_000;
const MAX_YIELD_MS = 60_000;
const DEFAULT_MAX_OUTPUT_CHARS = 20_000;
const HARD_MAX_OUTPUT_CHARS = 200_000;
const SESSION_TTL_MS = 10 * 60 * 1000;
const MAX_OPEN_SESSIONS = 16;
const OUTPUT_HEAD_RATIO = 0.55;

// ─── Process registry ──────────────────────────────────────────────
//
// Module-level singleton — sessions outlive a tool call by design (that
// is the whole point). Sessions self-evict when their process exits, on
// idle TTL, or when the caller invokes the (private) `close` action.

type Status = 'running' | 'exited';

interface NodePtyModule {
  spawn: (
    file: string,
    args: string[] | string,
    options: {
      name?: string;
      cols?: number;
      rows?: number;
      cwd?: string;
      env?: NodeJS.ProcessEnv;
      useConpty?: boolean;
      useConptyDll?: boolean;
    },
  ) => NodePtyProcess;
}

interface NodePtyProcess {
  pid: number;
  onData(cb: (data: string) => void): void;
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): void;
  write(data: string): void;
  kill(signal?: string): void;
}

interface SessionRecord {
  output: ProcessOutput;
  id: string;
  owner: string;
  closing?: boolean;
  cmd: string;
  cwd: string;
  mode: 'pipe' | 'pty';
  proc: ChildProcess | NodePtyProcess;
  status: Status;
  exitCode: number | null;
  /** Accumulated output that hasn't been returned to the model yet. */
  pending: string;
  /** True final output retained after `pending` becomes the bounded head. */
  pendingTail: string;
  /** Total source characters observed since the last drain. */
  pendingTotalChars: number;
  /** Per-drain response budget chosen when the session was spawned. */
  maxOutputChars: number;
  /** Set when the buffer overflowed since the last read. */
  truncated: boolean;
  /** Timestamp the process was spawned at. PR 5 — surfaced by
   *  `list_sessions` so the model knows session age. */
  startedAtMs: number;
  /** Timestamp of the last interaction; used for idle TTL eviction. */
  lastTouchMs: number;
  /** pty, or stdin was written: empty polls keep short interactive waits. */
  interactive: boolean;
  /** The model was told this session is running (it may now work meanwhile). */
  runningReported: boolean;
  /**
   * Agent (runner) that last saw `running`. Subagents share the session id,
   * so only this agent may receive the exit notice; a runner that is gone
   * simply leaves the exit for a normal poll.
   */
  recipient: unknown;
  /** The model has seen this session's exit (poll or background notice). */
  exitReported: boolean;
  /** Resolved when the process exits — lets yield logic short-circuit. */
  exitedPromise: Promise<void>;
  /** Trips the exitedPromise. */
  markExited: (code: number | null) => void;
  /** Cleans the process and removes from the registry. */
  dispose: (reason: string) => void;
}

const sessions = new Map<string, SessionRecord>();
/**
 * Exits already delivered through a background notice. A later poll of the
 * same id answers from here instead of failing as an unknown session.
 */
interface ReportedExit { owner: string; exitCode: number | null; outputRef: string }
const reportedExits = new Map<string, ReportedExit>();
const MAX_REPORTED_EXITS = 64;
let admissionReservations = 0;
let sweeper: ReturnType<typeof setInterval> | undefined;
function sessionOwner(ctx: Pick<ToolContext, 'sessionId' | 'projectName' | 'cwd'>): string {
  return ctx.sessionId ?? `legacy:${ctx.projectName}:${ctx.cwd}`;
}

let cachedPty: NodePtyModule | null | undefined = undefined;

async function loadNodePty(): Promise<NodePtyModule | null> {
  if (cachedPty !== undefined) return cachedPty;
  try {
    const specifier = 'node-pty';
    const mod = (await import(/* @vite-ignore */ specifier)) as NodePtyModule;
    cachedPty = mod;
    return mod;
  } catch {
    cachedPty = null;
    return null;
  }
}

function nowMs(): number {
  return Date.now();
}

function reapIdleSessions(): void {
  const cutoff = nowMs() - SESSION_TTL_MS;
  for (const rec of sessions.values()) {
    if (rec.lastTouchMs < cutoff) {
      rec.dispose('idle-ttl');
    }
  }
  if (sessions.size === 0 && sweeper) { clearInterval(sweeper); sweeper = undefined; }
}

function enforceMaxOpen(): void {
  if (sessions.size <= MAX_OPEN_SESSIONS) return;
  // Evict the oldest idle session. Running sessions are kept if possible.
  const candidates = [...sessions.values()].sort((a, b) => a.lastTouchMs - b.lastTouchMs);
  for (const rec of candidates) {
    if (sessions.size <= MAX_OPEN_SESSIONS) break;
    if (rec.status === 'exited') {
      rec.dispose('max-open-evict-exited');
    }
  }
  // Running sessions are never evicted to admit unrelated work.
}

function appendOutput(rec: SessionRecord, chunk: string, maxChars: number): void {
  if (!chunk) return;
  rec.output.append(chunk);
  rec.pendingTotalChars += chunk.length;

  if (!rec.truncated) {
    if (rec.pending.length + chunk.length <= maxChars) {
      rec.pending += chunk;
      return;
    }

    const headCapacity = Math.floor(maxChars * OUTPUT_HEAD_RATIO);
    const tailCapacity = maxChars - headCapacity;
    const previousPending = rec.pending;
    const neededForHead = Math.max(0, headCapacity - previousPending.length);
    rec.pending = (previousPending + chunk.slice(0, neededForHead)).slice(0, headCapacity);

    // Avoid concatenating the entire oversized chunk. The source chunk is
    // unavoidable, but retained memory remains bounded by maxChars.
    if (chunk.length >= tailCapacity) {
      rec.pendingTail = chunk.slice(chunk.length - tailCapacity);
    } else {
      const priorTailChars = Math.max(0, tailCapacity - chunk.length);
      rec.pendingTail = previousPending.slice(-priorTailChars) + chunk;
    }
    rec.truncated = true;
    return;
  }

  const tailCapacity = maxChars - Math.floor(maxChars * OUTPUT_HEAD_RATIO);
  if (chunk.length >= tailCapacity) {
    rec.pendingTail = chunk.slice(chunk.length - tailCapacity);
  } else {
    rec.pendingTail = (rec.pendingTail.slice(-(tailCapacity - chunk.length)) + chunk)
      .slice(-tailCapacity);
  }
}

function pendingMarker(omittedChars: number): string {
  return `\n[truncated: ${omittedChars} chars omitted; preserved beginning and true tail]\n`;
}

function unicodeSafePrefix(source: string, maxChars: number): string {
  let end = Math.min(source.length, Math.max(0, maxChars));
  if (end > 0) {
    const last = source.charCodeAt(end - 1);
    if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  }
  return source.slice(0, end);
}

function unicodeSafeSuffix(source: string, maxChars: number): string {
  let start = Math.max(0, source.length - Math.max(0, maxChars));
  if (start < source.length) {
    const first = source.charCodeAt(start);
    if (first >= 0xdc00 && first <= 0xdfff) start += 1;
  }
  return source.slice(start);
}

function formatTruncatedPending(rec: SessionRecord): { output: string; omittedChars: number } {
  const limit = rec.maxOutputChars;
  let omittedChars = Math.max(1, rec.pendingTotalChars - limit);
  let marker = pendingMarker(omittedChars);
  let headChars = 0;
  let tailChars = 0;
  let selectedHead = '';
  let selectedTail = '';
  let stable = false;

  for (let i = 0; i < 32; i += 1) {
    if (marker.length >= limit) break;
    const available = limit - marker.length;
    selectedHead = unicodeSafePrefix(rec.pending, Math.floor(available * OUTPUT_HEAD_RATIO));
    selectedTail = unicodeSafeSuffix(rec.pendingTail, available - selectedHead.length);
    headChars = selectedHead.length;
    tailChars = selectedTail.length;

    const nextOmitted = Math.max(0, rec.pendingTotalChars - headChars - tailChars);
    if (nextOmitted === omittedChars) {
      stable = true;
      break;
    }
    omittedChars = nextOmitted;
    marker = pendingMarker(omittedChars);
  }

  if (!stable || marker.length >= limit) {
    return {
      output: `[truncated:${rec.pendingTotalChars} chars]`.slice(0, limit),
      omittedChars: rec.pendingTotalChars,
    };
  }

  return {
    output: selectedHead + marker + selectedTail,
    omittedChars,
  };
}

function drainPending(rec: SessionRecord): {
  output: string;
  truncated: boolean;
  omittedChars: number;
  inputChars: number;
} {
  const truncated = rec.truncated;
  const inputChars = rec.pendingTotalChars;
  const formatted = truncated
    ? formatTruncatedPending(rec)
    : { output: rec.pending, omittedChars: 0 };
  rec.pending = '';
  rec.pendingTail = '';
  rec.pendingTotalChars = 0;
  rec.truncated = false;
  return { output: formatted.output, truncated, omittedChars: formatted.omittedChars, inputChars };
}

function clampYield(raw: unknown, fallback: number, kind: 'start' | 'poll' | 'input' = 'input'): number {
  const n = typeof raw === 'number' && Number.isFinite(raw) ? raw : fallback;
  // Windows process startup and test runners commonly outlive a 1s poll.
  // Keep zero as an explicit async launch/poll; positive waits give the
  // process time to finish without requiring another model round. Exit and
  // cancellation still release the wait immediately; interactive input stays fast.
  const minimum = process.platform === 'win32' && n > 0
    ? kind === 'start' ? 10_000 : kind === 'poll' ? 5_000 : 0
    : 0;
  return Math.min(Math.max(0, minimum, n), MAX_YIELD_MS);
}

/**
 * Wait bound for an empty poll. Non-interactive commands (tests, builds,
 * lint) are awaited to completion up to a long floor; explicit zero still
 * polls immediately. Interactive sessions keep the platform poll bounds.
 */
function emptyPollYield(raw: unknown, rec: SessionRecord): number {
  if (rec.interactive) return clampYield(raw, DEFAULT_POLL_YIELD_MS, 'poll');
  const n = typeof raw === 'number' && Number.isFinite(raw) ? raw : DEFAULT_POLL_YIELD_MS;
  if (n <= 0) return 0;
  return Math.min(Math.max(n, COMPLETION_POLL_FLOOR_MS), MAX_YIELD_MS);
}

function clampMaxChars(raw: unknown): number {
  const n = typeof raw === 'number' && Number.isFinite(raw) ? raw : DEFAULT_MAX_OUTPUT_CHARS;
  return Math.min(Math.max(1_000, n), HARD_MAX_OUTPUT_CHARS);
}

function resolveWorkdir(
  ctx: ToolContext,
  raw: unknown,
): { ok: true; cwd: string } | { ok: false; reason: string } {
  if (typeof raw !== 'string' || raw.length === 0) return { ok: true, cwd: ctx.cwd };
  const resolved = resolveWorkspacePath(raw, ctx, 'read');
  if (!resolved.ok) return resolved;
  if (resolved.external) {
    return {
      ok: false,
      reason:
        `workdir '${raw}' is an authorized external root, but persistent shell execution ` +
        'stays scoped to a real project root',
    };
  }
  return { ok: true, cwd: resolved.abs };
}

function describeResult(
  rec: SessionRecord,
  drained: { output: string; truncated: boolean; omittedChars: number; inputChars: number },
): string {
  const header = [
    `session_id=${rec.id}`,
    `status=${rec.status}`,
    `output_ref=${rec.output.id}`,
    rec.status === 'exited' ? `exit=${rec.exitCode ?? 'signal'}` : null,
    drained.truncated ? 'output_truncated=true' : null,
    drained.truncated ? `output_omitted_chars=${drained.omittedChars}` : null,
  ]
    .filter(Boolean)
    .join(' ');
  const body = drained.output || '(no new output)';
  return `${header}\n\n${body}`;
}

function resultForDrain(
  rec: SessionRecord,
  drained: { output: string; truncated: boolean; omittedChars: number; inputChars: number },
  recipient?: unknown,
): ToolResult {
  if (rec.status === 'running') {
    rec.runningReported = true;
    rec.recipient = recipient ?? null;
  } else {
    rec.exitReported = true;
  }
  const content = describeResult(rec, drained);
  // Inline reduction and source loss are distinct. The spool can recover the
  // former only while its own acquisition remained complete.
  return {
    content,
    structuredData: { sessionId: rec.id, state: rec.closing && rec.status !== 'exited' ? 'stopping' : rec.status, exitCode: rec.exitCode, output: rec.output.evidence() },
    ...(drained.truncated
      ? {
          sourceTruncations: [{
            technique: 'bounded-stream-cap',
            inputSize: drained.inputChars,
            outputSize: drained.output.length,
            unit: 'chars' as const,
            recoverable: rec.output.evidence().complete,
          }],
        }
      : {}),
  };
}

// ─── Spawn helpers ─────────────────────────────────────────────────

async function spawnSession(opts: {
  owner: string;
  command: CommandSpec;
  cmd: string;
  cwd: string;
  mode: 'pipe' | 'pty';
  cols: number;
  rows: number;
  maxChars: number;
  /** Per-project PHP/Python (not Node) to put on PATH for the session. */
  runtimeEnv?: AgentRuntimeEnv;
  /** Revalidate ownership immediately before the physical spawn. */
  assertFence?: () => void;
}): Promise<SessionRecord> {
  const env = applyRuntimeEnv(cleanProcessEnv(), opts.runtimeEnv);
  const id = randomUUID().slice(0, 8);
  let proc: ChildProcess | NodePtyProcess;
  let resolveExit!: () => void;
  const exitedPromise = new Promise<void>((res) => {
    resolveExit = res;
  });
  const output = new ProcessOutput(opts.owner);
  const launch = commandLaunch(opts.command);
  try {
  if (opts.mode === 'pty') {
    const pty = await loadNodePty();
    if (!pty) {
      throw new Error(
        'exec_command(tty=true) needs node-pty.\n' +
          '  Install:  npm install node-pty\n' +
          '  Or call again with tty=false (default) — pipe mode works for most REPLs.',
      );
    }
    opts.assertFence?.();
    proc = pty.spawn(launch.executable,
      process.platform === 'win32' && launch.windowsVerbatimArguments ? launch.args.join(' ') : launch.args, {
      name: 'xterm-color',
      cols: opts.cols,
      rows: opts.rows,
      cwd: opts.cwd,
      env,
      ...electronWindowsPtyOptions(),
    });
  } else {
    const isWindows = process.platform === 'win32';
    opts.assertFence?.();
    proc = nodeSpawn(launch.executable, launch.args, {
      cwd: opts.cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: !isWindows,
      windowsHide: true,
      windowsVerbatimArguments: launch.windowsVerbatimArguments,
    });
  }
  } catch (error) { output.finish(); throw error; }

  const untrackProcess = trackProcessTree(proc.pid);

  const rec: SessionRecord = {
    output,
    id,
    owner: opts.owner,
    cmd: opts.cmd,
    cwd: opts.cwd,
    mode: opts.mode,
    proc,
    status: 'running',
    exitCode: null,
    pending: '',
    pendingTail: '',
    pendingTotalChars: 0,
    maxOutputChars: opts.maxChars,
    truncated: false,
    startedAtMs: nowMs(),
    lastTouchMs: nowMs(),
    interactive: opts.mode === 'pty',
    runningReported: false,
    recipient: null,
    exitReported: false,
    exitedPromise,
    markExited: (code) => {
      if (rec.status === 'exited') return;
      output.finish();
      untrackProcess();
      rec.status = 'exited';
      rec.exitCode = code;
      resolveExit();
    },
    dispose: (_reason) => {
      if (rec.closing) return;
      rec.closing = true;
      if (rec.status === 'exited') { sessions.delete(id); return; }
      void killProcessTree(proc.pid, 'SIGKILL').finally(() => {
        // Never manufacture an exit receipt before the transport has drained.
        try { if (rec.status === 'running') proc.kill(); } catch { /* already closed */ }
        void rec.exitedPromise.then(() => sessions.delete(id));
      });
    },
  };

  if (opts.mode === 'pty') {
    const ptyProc = proc as NodePtyProcess;
    ptyProc.onData((data) => {
      appendOutput(rec, data, opts.maxChars);
    });
    ptyProc.onExit(({ exitCode }) => {
      rec.markExited(exitCode);
    });
  } else {
    const childProc = proc as ChildProcess;
    childProc.stdout?.setEncoding('utf-8');
    childProc.stderr?.setEncoding('utf-8');
    childProc.stdout?.on('data', (chunk: Buffer | string) => {
      appendOutput(rec, chunk.toString(), opts.maxChars);
    });
    childProc.stderr?.on('data', (chunk: Buffer | string) => {
      // Merge stderr into the same buffer — keeps ordering relative to
      // stdout. The model rarely needs to distinguish, and a separate
      // channel would double the response shape complexity.
      appendOutput(rec, chunk.toString(), opts.maxChars);
    });
    childProc.on('close', (code, signal) => {
      rec.markExited(code ?? (signal ? -1 : null));
    });
    childProc.on('error', (e) => {
      appendOutput(rec, `\n[spawn-error] ${e.message}\n`, opts.maxChars);
      rec.markExited(-1);
    });
  }

  sessions.set(id, rec);
  if (!sweeper) { sweeper = setInterval(reapIdleSessions, 30_000); sweeper.unref(); }
  enforceMaxOpen();
  return rec;
}

function writeToSession(rec: SessionRecord, chars: string): void {
  if (!chars) return;
  rec.interactive = true;
  if (rec.mode === 'pty') {
    (rec.proc as NodePtyProcess).write(chars);
  } else {
    const stdin = (rec.proc as ChildProcess).stdin;
    if (stdin && !stdin.destroyed) stdin.write(chars);
  }
}

async function awaitYield(rec: SessionRecord, yieldMs: number, signal?: AbortSignal): Promise<void> {
  if (yieldMs <= 0) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    await Promise.race([rec.exitedPromise, new Promise<void>(resolve => {
      timer = setTimeout(resolve, yieldMs);
      onAbort = () => resolve();
      if (signal?.aborted) resolve();
      else signal?.addEventListener('abort', onAbort, { once: true });
    })]);
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) signal?.removeEventListener('abort', onAbort);
  }
}

// ─── Tool: exec_command ────────────────────────────────────────────

const EXEC_COMMAND_DESC =
  'Spawn a shell command as a PERSISTENT session and return whatever it emits within a short yield window. ' +
  'If the process is still alive when yield expires, you get back a `session_id` you can drive with `write_stdin`.\n' +
  '\n' +
  'USE: for long builds/tests, overlapping independent checks, or commands that interact across turns — REPLs (`node`, `python -i`, `psql`), ' +
  'interactive scaffolders (`npm init`, `gh auth login`), TUI commands that prompt for choices.\n' +
  'USE: when you need to send several lines of stdin separated by reading responses.\n' +
  'Completed commands return their exit code and need no polling. Only poll a returned running session with `write_stdin`; short queries can use `run_command`.\n' +
  'The call waits up to `yield_time_ms` and returns as soon as the process exits: keep the default for checks you will wait on. ' +
  'If a session you left running exits while you do other work, its final status and unread output are attached to your next tool result.\n' +
  'Output is retained (`output_ref`) and returned as beginning + true tail within `max_output_chars`; do not redirect it to a file just to shorten it.\n' +
  "DON'T: spawn long-running servers (`npm run dev`, watch modes) here — the session will be evicted after " +
  '10 min of model inactivity even if the server is healthy. Use a background terminal for those.\n' +
  'An evicted session is gone. Use `list_sessions` only for a lost ID or a session-not-active error; known running IDs can be used directly.\n' +
  "The shell is the platform default (cmd.exe on Windows, /bin/sh on POSIX) — see the system prompt's OS line for shell-specific dos/don'ts.\n" +
  '\n' +
  `Defaults: tty=false (pipe); yields after ~${DEFAULT_EXEC_YIELD_MS}ms; output capped at ~${DEFAULT_MAX_OUTPUT_CHARS} chars. ` +
  `Output beyond cap preserves a bounded beginning and the true final output; ` +
  `\`output_truncated=true\` and \`output_omitted_chars=N\` report when and how much was omitted.`;

export const execCommand: CoderTool = {
  name: 'exec_command',
  effectBoundary: 'shell',
  description: EXEC_COMMAND_DESC,
  source: 'native',
  mutates: true,
  parallelSafe: false,
  riskLevel: 'execute',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'object', description: 'Explicit CommandSpec: {kind:"argv",executable,args} bypasses shell quoting; {kind:"shell",script,shell} selects cmd, powershell, pwsh, sh or bash.',
        properties: { kind: { type: 'string', enum: ['argv','shell'] }, executable: { type: 'string' }, args: { type: 'array', items: { type: 'string' } }, script: { type: 'string' }, shell: { type: 'string', enum: ['cmd','powershell','pwsh','sh','bash'] } }, required: ['kind'], additionalProperties: false },
      cmd: {
        type: 'string',
        description: 'Shell command line. Passed to /bin/sh -c (or cmd.exe /c on Windows).',
      },
      workdir: {
        type: 'string',
        description: 'Working directory. Relative paths resolve against the primary project; in a global session use "<project-slug>/subdir".',
      },
      tty: {
        type: 'boolean',
        description: 'Force a real pty (node-pty). Use only when the command gates on isatty(). Default false (pipe).',
      },
      yield_time_ms: {
        type: 'number',
        description: `Wait for output/exit; returns early on exit or cancellation. Default ${DEFAULT_EXEC_YIELD_MS}, max ${MAX_YIELD_MS}. On Windows positive waits are at least 10000ms. Pass a short wait or zero only when you have independent work to do meanwhile.`,
      },
      cols: { type: 'number', description: 'PTY columns. Defaults to 120.' },
      rows: { type: 'number', description: 'PTY rows. Defaults to 30.' },
      max_output_chars: { type: 'integer', minimum: 1000, maximum: HARD_MAX_OUTPUT_CHARS, description: 'Maximum inline characters per drain.' },
      max_output_tokens: { type: 'integer', minimum: 250, description: 'Deprecated approximate alias: each requested token reserves 4 characters.' },
    },
    required: [],
    additionalProperties: false,
  },
  handler: async (args, ctx: ToolContext): Promise<ToolResult> => {
    reapIdleSessions();
    let command: CommandSpec;
    try { command = commandSpec(args.command, args.cmd); } catch (error) { return err(String(error)); }
    const cmd = commandDisplay(command);

    const unsafeProcessCommand = unsafeProcessCommandRefusal(cmd);
    if (unsafeProcessCommand) return err(unsafeProcessCommand);

    const workdir = resolveWorkdir(ctx, args.workdir);
    if (!workdir.ok) return err(`exec_command: ${workdir.reason}`);
    const cwd = workdir.cwd;
    const mode: 'pipe' | 'pty' = args.tty === true ? 'pty' : 'pipe';
    const yieldMs = clampYield(args.yield_time_ms, DEFAULT_EXEC_YIELD_MS, 'start');
    const maxChars = clampMaxChars(args.max_output_chars ?? (typeof args.max_output_tokens === 'number' ? args.max_output_tokens * 4 : undefined));
    const cols = typeof args.cols === 'number' && Number.isFinite(args.cols) ? args.cols : 120;
    const rows = typeof args.rows === 'number' && Number.isFinite(args.rows) ? args.rows : 30;

    if (ctx.ports?.commands) {
      if (ctx.retainWorkspaceMutationUntil && !ctx.ports.commands.supportsWorkspaceExitReceipts) return err('Persistent command adapter cannot retain shared workspace ownership until physical process exit');
      if (args.command !== undefined && !ctx.ports.commands.commandSpecSupported) return err('Persistent adapter does not support CommandSpec');
      if (ctx.ports.commands.mutationFenceAttested !== true) return err('Persistent command adapter lacks physical ownership');
      return ctx.ports.commands.start({ command: cmd, commandSpec: command, cwd, tty: mode === 'pty', yieldMs, columns: cols, rows,
        maxOutputBytes: Math.min(800_000, maxChars * 4), runtimeEnv: ctx.runtimeEnv, signal: ctx.signal, onProcessExit: ctx.retainWorkspaceMutationUntil,
        assertFence: () => assertMutationFence(ctx.mutationFence, { kind: 'shell', operation: 'exec', resource: cmd }) });
    }

    let rec: SessionRecord;
    let reserved = false;
    try {
      if (sessions.size + admissionReservations >= MAX_OPEN_SESSIONS) return err(`exec_command: session quota (${MAX_OPEN_SESSIONS}) reached; stop or drain an existing session first.`);
      admissionReservations++;
      reserved = true;
      assertMutationFence(ctx.mutationFence, {
        kind: 'shell',
        operation: 'exec',
        resource: cmd,
      });
      rec = await spawnSession({
        owner: sessionOwner(ctx),
        command,
        cmd,
        cwd,
        mode,
        cols,
        rows,
        maxChars,
        runtimeEnv: ctx.runtimeEnv,
        assertFence: () => assertMutationFence(ctx.mutationFence, {
          kind: 'shell',
          operation: 'exec',
          resource: cmd,
        }),
      });
    } catch (e) {
      return err(`exec_command: spawn failed — ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      if (reserved) admissionReservations--;
    }

    // Surface abort to the session.
    ctx.retainWorkspaceMutationUntil?.(rec.exitedPromise);
    const onAbort = () => rec.dispose('runner-abort');
    if (ctx.signal) {
      if (ctx.signal.aborted) onAbort();
      else ctx.signal.addEventListener('abort', onAbort, { once: true });
      void rec.exitedPromise.then(() => ctx.signal?.removeEventListener('abort', onAbort));
    }

    await awaitYield(rec, yieldMs, ctx.signal);
    rec.lastTouchMs = nowMs();
    const drained = drainPending(rec);

    if (rec.status === 'exited') {
      // Process completed within the yield window — clean up the registry
      // entry so the model doesn't try to write_stdin into a corpse.
      sessions.delete(rec.id);
    }

    return resultForDrain(rec, drained, ctx.runner);
  },
};

// ─── Tool: write_stdin ─────────────────────────────────────────────

const WRITE_STDIN_DESC =
  'Send bytes to an exec_command session\'s stdin, then yield briefly to collect new output. ' +
  'Use `chars=""` (default) as a non-destructive poll to check whether the session is still alive ' +
  'and pick up output emitted since the last read. For a command that never received input, an empty poll ' +
  `waits until the process exits (up to yield_time_ms, at least ${COMPLETION_POLL_FLOOR_MS}ms) and returns immediately on exit.\n` +
  '\n' +
  'USE: after `exec_command` returned with status=running and you have an answer/command to push.\n' +
  'USE: with empty chars to poll a session that needs more time to produce its prompt.\n' +
  "DON'T: forget the trailing newline if the REPL expects line-buffered input — pass `chars: '5+5\\n'`, " +
  "not `'5+5'`. The tool does NOT auto-append newlines.\n" +
  "DON'T: call after `status=exited` — the session_id has been reaped. exec_command a new session.";

/**
 * PR 5 — formatted age helper used by `list_sessions` and the rich
 * `write_stdin` error payload. Returns "5s", "3m", "1h2m" style.
 */
function formatAgeMs(ms: number): string {
  if (ms < 1_000) return `${ms}ms`;
  const totalSec = Math.floor(ms / 1_000);
  if (totalSec < 60) return `${totalSec}s`;
  const totalMin = Math.floor(totalSec / 60);
  if (totalMin < 60) return `${totalMin}m`;
  const hours = Math.floor(totalMin / 60);
  const mins = totalMin % 60;
  return mins === 0 ? `${hours}h` : `${hours}h${mins}m`;
}

/**
 * Detect a `write_stdin` misfire: the model meant to call a different tool
 * (most often `write_file`) but stuffed the tool name / a path into
 * `session_id` and the payload into `chars`. Real session ids are 8 lowercase
 * hex chars (`randomUUID().slice(0, 8)`); a `session_id` that isn't that shape
 * was never returned by `exec_command`, so retrying it (or polling
 * `list_sessions`, which is correctly empty) can never succeed. Returns a
 * redirect hint to append to the "session not active" error, or '' when the id
 * looks like a genuine (just-expired) session id.
 */
function detectMisfireHint(id: string, rawChars: unknown): string {
  if (/^[0-9a-f]{8}$/.test(id)) return ''; // genuine-shaped id → likely a real stale session
  const chars = typeof rawChars === 'string' ? rawChars : '';
  const looksLikeFile = chars.length > 80 || chars.includes('\n');
  const base =
    `MISFIRE: '${id}' is not a session_id — those are 8 hex chars (e.g. 'a1b2c3d4') ` +
    `returned by a prior \`exec_command\`. \`write_stdin\` ONLY writes to a live shell ` +
    `session's stdin; it does NOT create or edit files.`;
  const tail = looksLikeFile
    ? ` It looks like you meant to WRITE A FILE. If \`write_file\` isn't in your tools, ` +
      `use \`find_tools\` for its schema and call it through \`code_exec\`: ` +
      `\`return await tools.write_file({ path, content });\`.`
    : ` If you meant to call a different tool (e.g. \`${id}\`), call it directly — and ` +
      `use \`find_tools\` and \`code_exec\` if it isn't visible.`;
  return `${base}${tail}\n\n`;
}

/**
 * PR 5 — snapshot of the live session registry. Pure read; mutates
 * nothing. Used by `list_sessions` and by the rich error payload of
 * `write_stdin` when an unknown session id is passed.
 */
interface SessionSnapshot {
  id: string;
  cmd: string;
  cwd: string;
  status: Status;
  mode: 'pipe' | 'pty';
  startedAtMs: number;
  lastTouchMs: number;
  ageStr: string;
  idleStr: string;
}

function snapshotSessions(owner?: string): SessionSnapshot[] {
  const now = nowMs();
  return [...sessions.values()].filter(rec => !owner || rec.owner === owner).map((rec) => ({
    id: rec.id,
    cmd: rec.cmd,
    cwd: rec.cwd,
    status: rec.status,
    mode: rec.mode,
    startedAtMs: rec.startedAtMs,
    lastTouchMs: rec.lastTouchMs,
    ageStr: formatAgeMs(now - rec.startedAtMs),
    idleStr: formatAgeMs(now - rec.lastTouchMs),
  })).sort((a, b) => a.startedAtMs - b.startedAtMs);
}

const LIST_SESSIONS_DESC =
  'List the active exec_command sessions in this runner (id, status, age, idle). ' +
  'Returns `(no active sessions)` when the registry is empty.\n\n' +
  'USE: when you forgot the session_id, or when write_stdin returned ' +
  '"session not active" and you want to know which ids ARE valid.\n' +
  "DON'T: poll this in a loop — sessions only change when YOU call exec_command / write_stdin.";

export const listSessions: CoderTool = {
  name: 'list_sessions',
  description: LIST_SESSIONS_DESC,
  source: 'native',
  mutates: false,
  parallelSafe: true,
  repeatPolicy: 'volatile',
  riskLevel: 'read',
  parameters: {
    type: 'object',
    properties: {},
    additionalProperties: false,
  },
  handler: async (_args, ctx): Promise<ToolResult> => {
    if (ctx.ports?.commands) return ctx.ports.commands.list();
    reapIdleSessions();
    const snap = snapshotSessions(sessionOwner(ctx));
    if (snap.length === 0) {
      return ok('(no active sessions; spawn one with exec_command first)');
    }
    const lines = snap.map((s) => {
      const cmd = s.cmd.length > 60 ? s.cmd.slice(0, 57) + '...' : s.cmd;
      return `${s.id} | ${s.status} | ${s.mode} | age ${s.ageStr} | idle ${s.idleStr} | ${cmd}`;
    });
    return ok(
      `Active sessions (${snap.length}):\n` +
      `<id> | <status> | <mode> | <age since spawn> | <idle since last io> | <cmd>\n` +
      lines.join('\n'),
    );
  },
};

export const writeStdin: CoderTool = {
  name: 'write_stdin',
  effectBoundary: 'control',
  description: WRITE_STDIN_DESC,
  source: 'native',
  mutates: true,
  parallelSafe: false,
  riskLevel: 'execute',
  parameters: {
    type: 'object',
    properties: {
      session_id: {
        type: 'string',
        description: 'Session id returned by a prior `exec_command`.',
      },
      chars: {
        type: 'string',
        description: 'Bytes to write to stdin (no newline auto-appended). Empty string = background poll.',
      },
      yield_time_ms: {
        type: 'number',
        description: `Wait for output/exit; returns early on exit or cancellation. Empty polls of non-interactive commands wait at least ${COMPLETION_POLL_FLOOR_MS} (max ${MAX_YIELD_MS}) for completion; interactive empty polls default to ${DEFAULT_POLL_YIELD_MS} (Windows minimum 5000); input writes default to ${DEFAULT_WRITE_YIELD_MS}. Zero polls immediately.`,
      },
    },
    required: ['session_id'],
    additionalProperties: false,
  },
  handler: async (args, ctx: ToolContext): Promise<ToolResult> => {
    reapIdleSessions();
    const id = String(args.session_id ?? '').trim();
    if (!id) return err('write_stdin: session_id is required');
    const chars = typeof args.chars === 'string' ? args.chars : '';
    if (ctx.ports?.commands) {
      const yieldMs = clampYield(args.yield_time_ms, chars ? DEFAULT_WRITE_YIELD_MS : DEFAULT_POLL_YIELD_MS, chars ? 'input' : 'poll');
      return ctx.ports.commands.write({ sessionId: id, chars,
        yieldMs, signal: ctx.signal,
        assertFence: () => assertMutationFence(ctx.mutationFence, { kind: 'control', operation: 'write_stdin', resource: id }) });
    }
    const rec = sessions.get(id);
    const reported = reportedExits.get(id);
    if (!rec && !chars && reported && reported.owner === sessionOwner(ctx)) {
      // The exit was already delivered with an earlier tool result. A poll
      // is harmless; answer it truthfully instead of as an unknown session.
      return ok(
        `session_id=${id} status=exited output_ref=${reported.outputRef} exit=${reported.exitCode ?? 'signal'}\n\n` +
        '(no new output — this exit was already reported; do not poll this session again)',
      );
    }
    if (!rec || rec.owner !== sessionOwner(ctx)) {
      // PR 5 — rich error payload: list the IDs that ARE active so the
      // model can immediately self-correct instead of rotating
      // session_ids blindly. The failure-streak guard still escalates
      // if the model ignores the list and keeps retrying.
      const snap = snapshotSessions(sessionOwner(ctx));
      const activeStr = snap.length === 0
        ? '  (no active sessions — use `exec_command` to spawn one)'
        : snap.map((s) =>
            `  - ${s.id} (${s.status}, ${s.mode}, age ${s.ageStr}, idle ${s.idleStr}): ` +
            (s.cmd.length > 50 ? s.cmd.slice(0, 47) + '...' : s.cmd),
          ).join('\n');
      // Lead with the misfire redirect when present: it's the actionable
      // line, and the failure-streak guard only echoes the FIRST ~200 chars
      // of the error into its refusal — so the fix must come first.
      const misfire = detectMisfireHint(id, args.chars);
      return err(
        misfire +
        `write_stdin: session '${id}' is not active (exited / reaped by idle-TTL / never existed).\n` +
        `Active sessions right now:\n${activeStr}\n` +
        `A session that exited cannot be reopened — its stdin is gone. ` +
        `Stop retrying with this id. Either:\n` +
        `  (a) call \`write_stdin\` with one of the active session_ids above;\n` +
        `  (b) spawn a fresh session via \`exec_command\`; or\n` +
        `  (c) call \`list_sessions\` first to refresh your view, then decide.`,
      );
    }


    if (chars && rec.status === 'running') {
      try {
        assertMutationFence(ctx.mutationFence, {
          kind: 'control',
          operation: 'write_stdin',
          resource: id,
        });
        writeToSession(rec, chars);
      } catch (e) {
        return err(`write_stdin: write failed — ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    const yieldMs = chars
      ? clampYield(args.yield_time_ms, DEFAULT_WRITE_YIELD_MS, 'input')
      : emptyPollYield(args.yield_time_ms, rec);
    await awaitYield(rec, yieldMs, ctx.signal);
    rec.lastTouchMs = nowMs();
    const drained = drainPending(rec);

    if (rec.status === 'exited') {
      sessions.delete(rec.id);
    }

    return resultForDrain(rec, drained, ctx.runner);
  },
};

/** Upper bound on waiting for owned transports to close during disposal. A
 * descendant that inherits stdio can keep `close` from ever firing, and worker
 * shutdown awaits this before its remaining cleanup. The timer stays referenced
 * so an awaited disposal settles even in a standalone host. */
const DISPOSE_DRAIN_TIMEOUT_MS = 10_000;

/** Kill every persistent exec/write_stdin process tree in this JS realm. */
export async function disposeExecCommandSessions(reason = 'shutdown'): Promise<void> {
  if (sweeper) { clearInterval(sweeper); sweeper = undefined; }
  const owned = [...sessions.values()];
  for (const rec of owned) {
    rec.dispose(reason);
  }
  let deadline: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    Promise.all(owned.map(rec => rec.exitedPromise)),
    new Promise<void>(resolve => { deadline = setTimeout(resolve, DISPOSE_DRAIN_TIMEOUT_MS); }),
  ]);
  clearTimeout(deadline);
  for (const rec of owned) sessions.delete(rec.id);
}

// ─── Background exit notices ──────────────────────────────────────
//
// A session the model left running (it yielded `status=running`) and that
// exited unobserved is reported once, with the same body a poll would have
// returned. This replaces a poll-only model round with text appended to the
// tool result the model was already going to read.

function shortCommand(cmd: string): string {
  const flat = cmd.replace(/\s+/g, ' ').trim();
  return flat.length > 160 ? `${flat.slice(0, 157)}...` : flat;
}

function rememberReportedExit(rec: SessionRecord): void {
  reportedExits.set(rec.id, { owner: rec.owner, exitCode: rec.exitCode, outputRef: rec.output.id });
  while (reportedExits.size > MAX_REPORTED_EXITS) {
    const oldest = reportedExits.keys().next().value;
    if (oldest === undefined) break;
    reportedExits.delete(oldest);
  }
}

/**
 * Drain unobserved exits for one owner; each becomes a self-contained notice.
 * `recipient` is the draining agent; a session left running by another agent
 * of the same session (parent vs subagent) stays for that agent.
 */
export function takeUnreportedExitNotices(owner: string, recipient?: unknown): string[] {
  const notices: string[] = [];
  for (const rec of [...sessions.values()].sort((a, b) => a.startedAtMs - b.startedAtMs)) {
    if (rec.owner !== owner || rec.status !== 'exited' || rec.closing) continue;
    if (!rec.runningReported || rec.exitReported) continue;
    if (rec.recipient != null && rec.recipient !== recipient) continue;
    const drained = drainPending(rec);
    const body = resultForDrain(rec, drained).content;
    sessions.delete(rec.id);
    rememberReportedExit(rec);
    notices.push(
      `[background exec] session ${rec.id} exited while you worked (no poll needed). ` +
        `cmd: ${shortCommand(rec.cmd)}\n${body}`,
    );
  }
  return notices;
}

registerBackgroundNoticeSource((ctx) => takeUnreportedExitNotices(sessionOwner(ctx), ctx.runner));

// ─── Test hooks ────────────────────────────────────────────────────
// Exported only so unit tests can poke the registry. Not part of the
// stable surface; do not import from runner code.

export const __testing = {
  sessions,
  reportedExits,
  reapIdleSessions,
  disposeAll(): Promise<void> {
    reportedExits.clear();
    return disposeExecCommandSessions('test-reset');
  },
};

export const pollSession: CoderTool = {
  name: 'poll_session', source: 'native', mutates: false, parallelSafe: false, repeatPolicy: 'pollable', riskLevel: 'read',
  description: 'Collect new output from an owned command session without writing stdin.',
  parameters: { type: 'object', properties: { session_id: { type: 'string' }, yield_time_ms: { type: 'integer', minimum: 0, maximum: MAX_YIELD_MS } }, required: ['session_id'], additionalProperties: false },
  handler: (args, ctx) => writeStdin.handler({ ...args, chars: '' }, ctx),
};
export const stopSession: CoderTool = {
  name: 'stop_session', source: 'native', effectBoundary: 'control', mutates: true, parallelSafe: false, riskLevel: 'execute',
  description: 'Stop one owned command process tree and collect its final output. A stopping receipt means physical cleanup is still pending.',
  parameters: { type: 'object', properties: { session_id: { type: 'string' } }, required: ['session_id'], additionalProperties: false },
  handler: async (args, ctx) => {
    const id = String(args.session_id ?? '');
    const assertFence = () => assertMutationFence(ctx.mutationFence, { kind: 'control', operation: 'stop_session', resource: id });
    if (ctx.ports?.commands) return ctx.ports.commands.stop
      ? ctx.ports.commands.stop({ sessionId: id, yieldMs: 2000, signal: ctx.signal, assertFence })
      : err('Persistent adapter does not support explicit stop');
    const record = sessions.get(id);
    if (!record || record.owner !== sessionOwner(ctx)) return err('Command session not found for this owner');
    assertFence();
    record.dispose('explicit-stop');
    await awaitYield(record, 2000);
    return resultForDrain(record, drainPending(record));
  },
};
export const readSessionOutput: CoderTool = {
  name: 'read_process_output', source: 'native', mutates: false, parallelSafe: true, riskLevel: 'read',
  description: 'Read retained command output using output_ref. A cursor continues the same byte snapshot; omitted bytes beyond the spool quota are unrecoverable.',
  parameters: { type: 'object', properties: { output_ref: { type: 'string' }, cursor: { type: 'string' }, max_bytes: { type: 'integer', minimum: 4, maximum: 65536 } }, required: ['output_ref'], additionalProperties: false },
  handler: async (args, ctx) => {
    const input = { outputRef: String(args.output_ref), cursor: typeof args.cursor === 'string' ? args.cursor : undefined, limit: typeof args.max_bytes === 'number' ? args.max_bytes : undefined };
    if (ctx.ports?.commands) return ctx.ports.commands.readOutput ? ctx.ports.commands.readOutput(input) : err('Persistent adapter does not expose retained output');
    try {
      const page = await readProcessOutput(sessionOwner(ctx), input.outputRef, input.cursor, input.limit);
      return { content: page.text + `\n[next_cursor=${page.nextCursor ?? 'end'}; complete_source=${page.complete}]`, structuredData: page,
        ...(!page.complete ? { sourceTruncations: [{ technique: 'process-spool-quota', inputSize: page.observedBytes, outputSize: page.retainedBytes, unit: 'bytes' as const, recoverable: false }] } : {}) };
    } catch (error) { return err(error instanceof Error ? error.message : String(error)); }
  },
};
export const execCommandTools: CoderTool[] = [execCommand, writeStdin, listSessions, pollSession, stopSession, readSessionOutput];
